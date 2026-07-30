//! The concierge reply linter's violation LOG — drift as a number instead of an impression.
//!
//! The linter itself lives in TypeScript (`services/conciergeLint/`) because only the frontend
//! holds the roster it checks pills against. This module is the durable half: an append-only
//! JSONL sink at `<app_data>/concierge-lint.jsonl`, one object per violation.
//!
//! WHY A LOG AT ALL. Without it there is no way to tell a linter that is WORKING from a concierge
//! that has merely learned to phrase around it. A check whose count falls to zero while the
//! human's experience does not improve is a check to rewrite — and that is only knowable from a
//! count over time. The session counters (`stores/conciergeLintMetrics.ts`) answer "this run";
//! this file answers "since when".
//!
//! METADATA ONLY — NEVER REPLY TEXT, NEVER THE MATCHED SPAN. `services/conciergeAudit.ts` records
//! the prior decision this inherits: persisting concierge text "would put redacted-but-still-
//! sensitive prompts on disk without anyone asking for that." So a record carries the check id, the
//! severity, what the app did about it, how many characters the match covered, and — only when the
//! caller opts in via `[concierge.checks].log_matches` — a SHORT DIGEST of the span. The digest
//! distinguishes "the same violation 40 times" from "40 different ones" and cannot reproduce the
//! text. That is also all the feature needs.
//!
//! Three properties enforced here rather than trusted to the caller:
//!
//! 1. **NO FIELD CAN CARRY REPLY TEXT.** Every string field is SHAPE-checked, not merely length-
//!    capped. `hash` must be hex or it is dropped (and the drop is logged); `turn`, `check` and
//!    `severity` must look like identifiers — prose fails on its spaces and punctuation. Length
//!    capping alone was the first attempt and it was wrong in both directions: it wrote the first 16
//!    characters of a matched span to a file retention never deletes (enough for a name, a path
//!    fragment, or a token prefix), and it let `severity` become 64 characters of arbitrary caller
//!    text once that vocabulary was opened up. Relaxing a VOCABULARY never requires relaxing a SHAPE.
//!    The guard belongs on the writer because the writer is the thing that touches the disk.
//! 2. **A record is bounded, and so are its NUMBERS.** Identifiers are clipped, so one line stays a
//!    couple of hundred bytes — small enough that the single `write` under `O_APPEND` is line-atomic
//!    in practice, which is the guarantee `resources/sparkle-hook.mjs` relies on for the
//!    `hook-events/*.jsonl` logs this idiom is copied from. `count` and `span` are BOUNDED rather
//!    than clamped: saturating an absurd `count` to `u32::MAX` put 4.29 billion into a total the
//!    report sums, which corrupts the one number this feature exists to make trustworthy.
//! 3. **It can never break the reply path.** Two layers, because one was not enough. The inner one:
//!    `record_violation` swallows every failure into a `tracing::warn!`. The outer one: the
//!    `#[tauri::command]` takes `Option<serde_json::Value>` and coerces, rather than a strict typed
//!    payload — Tauri rejects the `invoke` promise during ARGUMENT DESERIALIZATION, before the
//!    command body runs at all, so a strict `ts: i64` meant a caller passing a float, a `Date`, or an
//!    ISO string got an unhandled rejection out of the logger. That is precisely the failure this
//!    module is written to prevent, and no amount of care inside the body could stop it. Any JSON
//!    now deserializes; `violation_from_json` does the coercion where it is pure and testable.
//!
//! NO CLOCK IN RUST. `ts` is supplied by the caller, following `history.rs` ("the frontend supplies
//! `id` and `created_at` ... Rust only stores"): the frontend already has the turn's wall-clock at
//! the moment it lints, and taking it here would pull in a second, slightly-different timestamp for
//! the same event. Retention keys on file SIZE, not on `ts`, so a caller with a skewed clock
//! degrades the report's ordering and nothing else.
//!
//! Inner functions are pure (they take `app_data: &Path`, never an `AppHandle`) so they unit-test
//! without a Tauri runtime; the `#[tauri::command]` is a thin wrapper that resolves the dir — the
//! convention stated at the top of `accounts.rs` and `trial.rs`.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// The sink's file name inside `<app_data>`. Flat, not in a subdirectory: there is exactly one of
/// these per install (violations are not per-agent), so a directory would only add a level.
pub const LINT_LOG_FILE: &str = "concierge-lint.jsonl";

/// Longest `hash` we will write. THE PRIVACY BACKSTOP: a short digest distinguishes repeats from
/// distinct violations; anything longer starts being able to carry the text itself.
pub const HASH_MAX_CHARS: usize = 16;

/// Is `s` hex? THE PRIVACY GATE — anything that is not the shape of a digest is not a digest,
/// whatever the caller called it, and reply text is what a non-digest value would be. Hex
/// specifically, because that is what every digest in this codebase looks like (the plan's own
/// example is `a19f3c`), and a narrow alphabet is what makes prose fail the check.
///
/// LENGTH IS DELIBERATELY NOT PART OF THIS. roborev 55671 (Medium): folding the length cap in here
/// meant a *valid* digest that was merely long got dropped — and the obvious caller implementation is
/// `sha256(span).hex()`, 64 characters, so EVERY hash would have been refused and the distinct-match
/// feature would have silently done nothing forever. A long hex string carries no text-leak risk by
/// this module's own argument, so it is clipped (which bounds the record just as well); only a
/// non-hex value is dropped, and that drop is logged.
fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Is `s` shaped like an identifier — the character class an app-generated id actually uses?
///
/// roborev 55671 (Medium): closing a 16-character leak in `hash` while widening `severity` to
/// arbitrary 64-character caller text was a net loss. Relaxing the VOCABULARY (an unfamiliar tier
/// must not cost the observation) never required relaxing the SHAPE. Prose fails this on its spaces
/// and punctuation; `critical`, `relay-paste`, `418` and any future tier pass.
///
/// Length is not checked here — over-long values are clipped, since a 200-character kebab-case id is
/// a bounded nuisance rather than a leak.
fn is_identifier_shaped(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// Sentinel for a field whose value was unusable but whose VIOLATION is still real. Recording the
/// observation under a visible placeholder beats dropping it — see `SEVERITIES` on why an undercount
/// is the failure mode that matters here.
const UNKNOWN: &str = "unknown";

/// What a diagnostic is allowed to say about a caller-supplied identifier.
///
/// roborev 55693 (Medium). THE PRIVACY ARGUMENT HAS TO COVER THE LOG, NOT JUST THE JSONL. Refusing a
/// prose `check` kept it out of `concierge-lint.jsonl` and then handed it to `tracing::warn!` — which
/// writes the rolling daily file (`logging.rs`; `retention.rs` records that it "rotates but never
/// deletes") that `support.rs` uploads with a support request. Sixty-four characters of unvalidated
/// reply text, LEAVING THE DEVICE, in the one place three commits of privacy work never looked. So a
/// diagnostic never echoes a value this module has just classified as possibly-text; it says the
/// value was unshaped and stops there.
fn loggable_id(s: &str) -> String {
    let t = s.trim();
    if is_identifier_shaped(t) {
        clip(t, ID_MAX_CHARS)
    } else {
        "<unshaped>".to_string()
    }
}

/// Ceiling on `count`. roborev 55671 (Medium): the coercion used `.min(u32::MAX)`, so `count: 1e10`
/// SATURATED to 4_294_967_295 and the report summed it straight into `TOTAL` — one malformed payload
/// inflating the all-time total by 4.29 billion, in the one number this feature exists to make
/// trustworthy. Worse, it was a regression: the strict-typed command it replaced rejected a
/// non-`u32` count at deserialization, losing the record but keeping the total honest. Matches within
/// a single reply cannot plausibly reach four digits, so an implausible value is floored to 1 rather
/// than clamped to the cap — a fabricated 10,000 would be just as untrue as a fabricated 4.29e9.
const COUNT_MAX: i64 = 10_000;

/// Ceiling on `span`, for the same reason. A concierge reply is not a megabyte.
const SPAN_MAX: i64 = 1_000_000;

/// Longest `turn` / `check` we will write. Both are app-generated identifiers (a turn ordinal, a
/// check id from the linter's registry), so these caps are far above any real value and exist only
/// to bound the record.
pub const ID_MAX_CHARS: usize = 64;

/// What the app DID about a violation. `warned` rendered it unchanged with a badge; `autofixed`
/// substituted the mechanically-derivable compliant form; `revised` re-prompted the concierge and
/// rendered the correction; `rendered_marked` is the give-up path after the one permitted retry.
///
/// THIS IS A SECOND COPY of a vocabulary owned by the frontend (`LINT_ACTIONS` in
/// `stores/conciergeLintMetrics.ts`), and a second list that drifts is exactly what this module
/// refuses to do for the CHECK ids. It is duplicated here anyway because an unknown action must be
/// refused — the report and the counters both key on it, and a typo bucketed as real corrupts the
/// only number anyone reads. The drift is made detectable instead of tolerated:
/// `the_action_vocabulary_matches_the_typescript_one` reads the TS file and asserts set equality, so
/// adding an action on one side fails the suite rather than silently undercounting the log.
pub const ACTIONS: [&str; 4] = ["warned", "autofixed", "revised", "rendered_marked"];

/// The policy tiers a check can be configured at, per plan §4. `off` is included because a violation
/// recorded while a check was being switched off is still a real observation.
///
/// PINNED, but deliberately NOT ENFORCED AT THE RECORD BOUNDARY — and those are different things.
///
/// (An earlier version of this paragraph said "there is nothing to pin a drift test against" and was
/// then immediately followed by the paragraph describing the pins that do exactly that — roborev
/// 55734. In a module whose review history is about comments claiming more or less than the code
/// delivers, that contradiction could have got the cross-language pin deleted as impossible.)
///
/// Not enforced means `normalize` accepts an unrecognized tier rather than refusing the record.
/// Refusing would mean that the day `[concierge.checks]` grows a fourth tier, every affected
/// violation is dropped with only a `tracing::warn!` while the session counters keep counting it —
/// the log would undercount against the numbers rendered beside it. Recording an unfamiliar severity
/// is the lesser evil: the report buckets whatever string it is given, so an odd value is VISIBLE
/// rather than absent. (`ACTIONS`, by contrast, IS enforced — an unknown action cannot be bucketed
/// harmlessly because the rollup keys on it.)
///
/// PINNED, and here is precisely what the pins do and do not buy — stated carefully because two
/// earlier versions of this comment claimed more than the tests delivered (roborev 55687, 55723).
///
/// The list exists THREE times: `config.rs::CONCIERGE_CHECK_SEVERITIES` (which owns it —
/// `[concierge.checks]` is where a user writes it), here, and
/// `services/conciergeLint/types.ts::LINT_SEVERITIES`. Two tests pin all three DECLARATIONS to each
/// other, one in-crate and one across the language boundary.
///
/// That is vocabulary drift only. It is NOT what makes a new tier behave correctly — a claim the
/// previous comment made and could not support. What guards the behaviour is
/// `SEVERITY_EFFECT` in `types.ts`: the blocking and skip decisions read an exhaustive
/// `satisfies Record<Severity, …>` table, so widening the vocabulary is a COMPILE ERROR at the site
/// that decides blocking. Pins catch a forgotten list; the table catches a forgotten decision. Both
/// are needed, and neither substitutes for the other.
#[allow(dead_code)] // only the pins read it — `normalize` deliberately does not match against it
pub const SEVERITIES: [&str; 3] = ["block", "warn", "off"];

/// One violation, exactly as it lands on disk. Field order is the serialized order, so the line
/// shape is the documented one:
/// `{"ts":…,"turn":"418","check":"relay-paste","severity":"block","action":"revised","count":1,"span":412,"hash":"a19f3c"}`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LintViolation {
    /// Epoch milliseconds, supplied by the caller (see the module header on why not by Rust).
    ///
    /// `None` — serialized as `null`, never omitted — means the caller gave us nothing usable. The
    /// report script already treats a non-numeric `ts` as unplaceable (sorts it last, excludes it
    /// from `--since`), so an unknown timestamp costs ordering for that one record and nothing else.
    /// Refusing the record instead would lose a real observation over a field the count does not
    /// depend on.
    #[serde(default)]
    pub ts: Option<i64>,
    /// The turn this violation was found in — an opaque ordinal/id, never prompt content.
    pub turn: String,
    /// The linter's check id (`relay-paste`, `bare-agent-name`, …). The authoritative list lives in
    /// the TS registry; restating it here would create a second list that drifts, and Rust would
    /// have no way to notice — the same discipline `[concierge.tools]` already follows.
    pub check: String,
    /// The severity the check was configured at when it fired.
    pub severity: String,
    /// One of `ACTIONS`.
    pub action: String,
    /// How many times this check matched in the reply. Defaulted so an older caller still records.
    #[serde(default = "one")]
    pub count: u32,
    /// CHARACTER COUNT of the matched span — never the span. Defaulted for the same reason.
    #[serde(default)]
    pub span: u32,
    /// Short digest of the matched span, present ONLY when the caller opts in
    /// (`[concierge.checks].log_matches`, default false). Absent, not null, when it is not supplied
    /// — a reader distinguishes "not logged" from "logged as empty".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

fn one() -> u32 {
    1
}

/// `<app_data>/concierge-lint.jsonl`.
pub fn lint_log_path(app_data: &Path) -> PathBuf {
    app_data.join(LINT_LOG_FILE)
}

/// Clip to `max` CHARACTERS (not bytes), so a multi-byte value can never be cut mid-codepoint into
/// a string that would serialize as a replacement character.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// Enforce the record's invariants, returning the value that will actually be written.
///
/// Rejects rather than coerces on the two ENUM fields: an unrecognized `action` or `severity` means
/// the caller and this module disagree about the vocabulary, and silently filing it under a
/// plausible-looking bucket would corrupt the only number anyone reads. A missing check id is the
/// same class of error. Everything else is clipped, because a too-long identifier is a bounded
/// nuisance while a rejected record is a lost observation.
fn normalize(v: &LintViolation) -> Result<LintViolation, String> {
    if v.check.trim().is_empty() {
        return Err("lint violation has no check id".to_string());
    }
    if !ACTIONS.contains(&v.action.as_str()) {
        // Names the SHAPE, never the value: `action` is arbitrary caller text at this point, and this
        // string is surfaced through `tracing::warn!` into the support-uploadable log (roborev 55693).
        return Err(format!(
            "lint action is not one of {ACTIONS:?} (got {} chars)",
            v.action.chars().count()
        ));
    }
    if v.severity.trim().is_empty() {
        return Err("lint violation has no severity".to_string());
    }
    // A check id that is not identifier-shaped is not a check the linter emits — and unlike a strange
    // severity, it cannot be bucketed harmlessly, because it BECOMES a row in the rollup. Refuse it
    // rather than filing prose as a check name.
    if !is_identifier_shaped(v.check.trim()) {
        return Err("lint violation check id is not identifier-shaped".to_string());
    }
    let hash = match v.hash.as_deref() {
        // Hex: safe to persist. Clipped, not dropped — see `is_hex`.
        Some(h) if is_hex(h) => Some(clip(h, HASH_MAX_CHARS)),
        // Not hex, so not a digest, so the only thing it plausibly is is reply text. Dropped —
        // never shortened, because sixteen characters of a matched span still carries a name or a
        // path fragment into a file retention never deletes. Logged, so a mis-integrated caller is
        // visible instead of silently producing no grouping signal at all.
        Some(_) => {
            tracing::warn!(
                check = %loggable_id(&v.check),
                "concierge lint log: non-digest hash dropped (log_matches must pass a hex digest, \
                 never the matched text)"
            );
            None
        }
        None => None,
    };
    Ok(LintViolation {
        ts: v.ts,
        // Shape-checked then clipped. An unusable turn is emptied rather than refused: nothing in the
        // rollup keys on it, so losing it costs correlation for one row and no more.
        turn: if is_identifier_shaped(v.turn.trim()) {
            clip(v.turn.trim(), ID_MAX_CHARS)
        } else {
            String::new()
        },
        check: clip(v.check.trim(), ID_MAX_CHARS),
        // The VOCABULARY is open (see `SEVERITIES`: refusing an unfamiliar tier would make the log
        // undercount against the counters shown beside it) but the SHAPE is not. Prose becomes
        // `unknown`, which keeps the observation and puts no caller text on disk.
        severity: if is_identifier_shaped(v.severity.trim()) {
            clip(v.severity.trim(), ID_MAX_CHARS)
        } else {
            UNKNOWN.to_string()
        },
        action: v.action.clone(),
        // Implausible values floor to the honest minimum rather than saturating into the total.
        count: if (1..=COUNT_MAX).contains(&(v.count as i64)) { v.count } else { 1 },
        span: if v.span as i64 <= SPAN_MAX { v.span } else { 0 },
        hash,
    })
}

/// Read a field as a string, tolerating a caller that sent a number (`turn: 418` rather than
/// `"418"`). Anything else — an object, an array, a bool, null, absent — yields `None`.
fn json_str(v: &serde_json::Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// Read a field as an integer, tolerating a float (truncated, as `Date.now()` never is but a computed
/// timestamp might be) and a numeric string. `None` when there is nothing numeric there.
fn json_i64(v: &serde_json::Value, key: &str) -> Option<i64> {
    match v.get(key) {
        Some(serde_json::Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f.trunc() as i64)),
        Some(serde_json::Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// Coerce an arbitrary `invoke` payload into a violation.
///
/// WHY THIS EXISTS RATHER THAN A TYPED COMMAND PARAMETER: Tauri deserializes command arguments
/// BEFORE the body runs, and a deserialization failure rejects the `invoke` promise — outside any
/// error handling this module could write. With a strict `ts: i64` a caller that passed a float, a
/// `Date`, an ISO string, or nothing at all got an unhandled rejection out of the violation logger,
/// which is the one failure mode the whole module is shaped to prevent. `Option<serde_json::Value>`
/// cannot fail to deserialize, so the coercion happens here — pure, and testable against garbage.
///
/// Lenient about SHAPE, strict about VOCABULARY: a missing `check` or an unknown `action` is still a
/// refusal, because those are what the rollup keys on.
pub fn violation_from_json(payload: Option<&serde_json::Value>) -> Result<LintViolation, String> {
    let v = payload.ok_or_else(|| "lint violation payload missing".to_string())?;
    if !v.is_object() {
        return Err(format!("lint violation payload is not an object: {}", kind_of(v)));
    }
    Ok(LintViolation {
        ts: json_i64(v, "ts"),
        turn: json_str(v, "turn").unwrap_or_default(),
        check: json_str(v, "check").unwrap_or_default(),
        severity: json_str(v, "severity").unwrap_or_default(),
        action: json_str(v, "action").unwrap_or_default(),
        // A negative or absurd count is a caller bug; one occurrence is the honest floor, since the
        // violation demonstrably happened at least once. BOUNDED, not clamped — `.min(u32::MAX)` let
        // `count: 1e10` land as 4.29 billion and the report summed it into TOTAL (roborev 55671).
        count: json_i64(v, "count").filter(|n| (1..=COUNT_MAX).contains(n)).unwrap_or(1) as u32,
        span: json_i64(v, "span").filter(|n| (0..=SPAN_MAX).contains(n)).unwrap_or(0) as u32,
        hash: json_str(v, "hash"),
    })
}

/// For the diagnostic above — naming the shape we got beats echoing a payload we do not trust.
fn kind_of(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// Append one violation to `<app_data>/concierge-lint.jsonl`, creating the file and its parent.
///
/// The fallible core: returns the reason on failure so tests can see it. Production callers go
/// through `record_violation`, which swallows. Written as ONE `write_all` of `{json}\n` on an
/// `O_APPEND` handle — the `hook-events/*.jsonl` idiom — so concurrent writers never interleave
/// mid-line. `normalize` bounds the record so that write stays small.
pub fn append_violation(app_data: &Path, v: &LintViolation) -> Result<(), String> {
    let record = normalize(v)?;
    let line = serde_json::to_string(&record).map_err(|e| format!("serialize violation: {e}"))?;
    // Defence in depth: serde_json escapes control characters, so a newline inside a field cannot
    // split the record. Assert it rather than assume it — a second line would be read as a second
    // violation and inflate the count this whole feature exists to make trustworthy.
    debug_assert!(!line.contains('\n'), "a serialized violation must be exactly one line");

    std::fs::create_dir_all(app_data).map_err(|e| format!("create app data dir: {e}"))?;
    let path = lint_log_path(app_data);
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    f.write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("append violation: {e}"))
}

/// Infallible entry point: append the violation, or log why we could not.
///
/// Returns whether a line was written — for tests and for a future "is the log healthy?" readout
/// ONLY. Nothing in the reply path may branch on it: the whole contract of this module is that
/// logging a violation cannot affect whether the human sees their reply.
pub fn record_violation(app_data: &Path, v: &LintViolation) -> bool {
    match append_violation(app_data, v) {
        Ok(()) => true,
        Err(e) => {
            // `loggable_id`, NOT `clip`: this line reaches the support-uploadable rolling log, and
            // `v.check` here is the RAW caller value — a refused record is exactly the case where it
            // may be reply text (roborev 55693).
            tracing::warn!(check = %loggable_id(&v.check), "concierge lint log write failed: {e}");
            false
        }
    }
}

/// Record one concierge-lint violation. Called from the linter at `concierge:done`.
///
/// CANNOT FAIL FROM THE CALLER'S POINT OF VIEW, and that holds for the ARGUMENT as well as the body:
/// the parameter is `Option<serde_json::Value>`, which no payload can fail to deserialize, so Tauri
/// never rejects the `invoke` promise before we get here. It returns `()`, so there is no error for
/// the frontend to handle. Every failure — a missing field, an unknown action, an unwritable disk —
/// is a `tracing::warn!` and nothing else.
#[tauri::command]
pub fn concierge_lint_log(app: AppHandle, violation: Option<serde_json::Value>) {
    let v = match violation_from_json(violation.as_ref()) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("concierge lint log: unusable payload: {e}");
            return;
        }
    };
    match crate::dev_identity::app_data_dir(&app) {
        Ok(dir) => {
            record_violation(&dir, &v);
        }
        Err(e) => tracing::warn!("concierge lint log: app_data_dir: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir()
            .join(format!("sparkle-lintlog-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn violation() -> LintViolation {
        LintViolation {
            ts: Some(1_769_649_600_123),
            turn: "418".to_string(),
            check: "relay-paste".to_string(),
            severity: "block".to_string(),
            action: "revised".to_string(),
            count: 1,
            span: 412,
            hash: None,
        }
    }

    fn lines(app_data: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(lint_log_path(app_data))
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("bad line {l:?}: {e}")))
            .collect()
    }

    /// THE SIDE EFFECT: a line lands on disk, in the documented shape, and reads back as the same
    /// record. Asserting the struct exists would prove nothing — the file is the product.
    #[test]
    fn appends_a_line_that_reads_back_as_the_documented_shape() {
        let dir = tmpdir("append");
        let v = LintViolation { hash: Some("a19f3c".to_string()), ..violation() };

        assert!(record_violation(&dir, &v), "the write must succeed on a writable dir");

        let got = lines(&dir);
        assert_eq!(got.len(), 1, "exactly one record per call");
        assert_eq!(
            got[0],
            serde_json::json!({
                "ts": 1_769_649_600_123_i64,
                "turn": "418",
                "check": "relay-paste",
                "severity": "block",
                "action": "revised",
                "count": 1,
                "span": 412,
                "hash": "a19f3c",
            }),
            "the on-disk object is the shape the report script and the pane parse"
        );
        // Round-trips back into the type the writer accepts.
        let raw = std::fs::read_to_string(lint_log_path(&dir)).unwrap();
        assert_eq!(serde_json::from_str::<LintViolation>(raw.trim()).unwrap(), v);
        assert!(raw.ends_with('\n'), "every record is newline-terminated so the next append is whole");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Appends accumulate rather than replacing — the file is a history, not a latest-value.
    #[test]
    fn successive_appends_accumulate_in_order() {
        let dir = tmpdir("accumulate");
        for (i, check) in ["relay-paste", "hedge-words", "relay-paste"].iter().enumerate() {
            record_violation(
                &dir,
                &LintViolation {
                    ts: Some(1_000 + i as i64),
                    check: check.to_string(),
                    severity: "warn".to_string(),
                    action: "warned".to_string(),
                    ..violation()
                },
            );
        }
        let got = lines(&dir);
        assert_eq!(got.len(), 3);
        let checks: Vec<&str> = got.iter().map(|v| v["check"].as_str().unwrap()).collect();
        assert_eq!(checks, ["relay-paste", "hedge-words", "relay-paste"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `hash` is OMITTED, not null, when the caller does not opt in. A reader must be able to tell
    /// "log_matches was off" from "the digest was empty", and `null` would conflate them.
    #[test]
    fn hash_is_absent_when_not_supplied() {
        let dir = tmpdir("nohash");
        record_violation(&dir, &violation());

        let raw = std::fs::read_to_string(lint_log_path(&dir)).unwrap();
        assert!(!raw.contains("hash"), "no hash key at all when none was passed: {raw}");
        assert!(lines(&dir)[0].get("hash").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE PRIVACY GATE. A caller that passes the matched TEXT as `hash` — the exact bug the
    /// metadata-only constraint exists to prevent — must put NO text on disk. Not less text: none.
    ///
    /// roborev 55656 (Medium). The first version of this guard CLIPPED to 16 characters, and its test
    /// asserted the clip. That still wrote `"I just sent Left"` — sixteen characters of verbatim reply
    /// text, enough for a name or a path fragment — into a file retention never deletes. Truncation
    /// was a mitigation dressed as enforcement; validating the digest SHAPE is the enforcement.
    #[test]
    fn a_prose_hash_is_dropped_entirely_rather_than_truncated_onto_disk() {
        let dir = tmpdir("hashgate");
        let secret = "I just sent Left Pair the following message: rebase onto origin/main and rerun";
        record_violation(&dir, &LintViolation { hash: Some(secret.to_string()), ..violation() });

        let raw = std::fs::read_to_string(lint_log_path(&dir)).unwrap();
        assert!(!raw.contains("hash"), "a non-digest value produces no hash key at all: {raw}");
        assert!(lines(&dir)[0].get("hash").is_none());
        // The specific regression: not one character of the span survives, not merely fewer of them.
        assert!(!raw.contains("I just sent"), "reply text must never reach the file");
        assert!(!raw.contains("Left"));
        // The violation itself is still recorded — losing the grouping signal must not lose the count.
        assert_eq!(lines(&dir)[0]["check"].as_str().unwrap(), "relay-paste");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The gate must accept what a real digest looks like, or it would drop every hash and the
    /// distinct-match count would always read 0.
    #[test]
    fn a_real_hex_digest_is_accepted_in_either_case() {
        let dir = tmpdir("hashok");
        for h in ["a19f3c", "A19F3C", "0", "0123456789abcdef"] {
            record_violation(&dir, &LintViolation { hash: Some(h.to_string()), ..violation() });
        }
        let got = lines(&dir);
        assert_eq!(got.len(), 4);
        let stored: Vec<&str> = got.iter().map(|v| v["hash"].as_str().unwrap()).collect();
        assert_eq!(stored, ["a19f3c", "A19F3C", "0", "0123456789abcdef"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A LONG BUT VALID digest is CLIPPED, not dropped. roborev 55671 (Medium): folding the length cap
    /// into the hex check meant the obvious caller implementation — `sha256(span).hex()`, 64 chars —
    /// had every hash refused, so `distinctMatches` would have read 0 forever and the distinct-match
    /// feature would have silently done nothing. Hex carries no text-leak risk; clipping bounds the
    /// record just as well as dropping it, and keeps the grouping signal.
    #[test]
    fn a_long_hex_digest_is_clipped_not_dropped() {
        let dir = tmpdir("hashlong");
        let sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        record_violation(&dir, &LintViolation { hash: Some(sha256.to_string()), ..violation() });

        let stored = lines(&dir)[0]["hash"].as_str().unwrap().to_string();
        assert_eq!(stored, &sha256[..HASH_MAX_CHARS], "the leading digest bytes are kept");
        assert_eq!(stored.chars().count(), HASH_MAX_CHARS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Long identifiers are clipped so one record stays inside the single small `write` that makes
    /// O_APPEND line-atomic in practice. Identifier-SHAPED but over-long is a bounded nuisance, not a
    /// leak, so it survives clipped rather than being dropped.
    #[test]
    fn long_identifiers_are_clipped_to_bound_the_record() {
        let dir = tmpdir("idclip");
        record_violation(
            &dir,
            &LintViolation {
                turn: "t".repeat(500),
                check: "c".repeat(500),
                severity: "s".repeat(500),
                ..violation()
            },
        );
        let got = lines(&dir);
        assert_eq!(got[0]["turn"].as_str().unwrap().chars().count(), ID_MAX_CHARS);
        assert_eq!(got[0]["check"].as_str().unwrap().chars().count(), ID_MAX_CHARS);
        assert_eq!(got[0]["severity"].as_str().unwrap().chars().count(), ID_MAX_CHARS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A clip must never split a codepoint — a mangled UTF-8 byte would make the whole LINE
    /// unparseable and cost every violation in it, not just the field. Asserted on the helper,
    /// because every field it is applied to is now charset-restricted to ASCII first.
    #[test]
    fn clipping_respects_character_boundaries() {
        assert_eq!(clip(&"é".repeat(200), ID_MAX_CHARS), "é".repeat(ID_MAX_CHARS));
        assert_eq!(clip("héllo", 2), "hé");
        assert_eq!(clip("short", 99), "short", "under the cap, unchanged");
    }

    /// THE OTHER TEXT LEAK, closed. roborev 55671 (Medium): the change that stopped writing 16
    /// characters of reply text via `hash` simultaneously widened `severity` from a closed enum to
    /// arbitrary 64-character caller text — four times longer than the leak just eliminated, in the
    /// same file retention never deletes. Relaxing the VOCABULARY did not require relaxing the SHAPE.
    #[test]
    fn prose_in_an_identifier_field_never_reaches_the_file() {
        let dir = tmpdir("prosefields");
        let prose = "the reply pasted the whole message I sent to Left Pair";
        record_violation(
            &dir,
            &LintViolation {
                turn: prose.to_string(),
                severity: prose.to_string(),
                ..violation()
            },
        );

        let raw = std::fs::read_to_string(lint_log_path(&dir)).unwrap();
        assert!(!raw.contains("Left Pair"), "no caller prose on disk: {raw}");
        assert!(!raw.contains("whole message"));
        let got = lines(&dir);
        assert_eq!(got[0]["severity"].as_str().unwrap(), "unknown", "recorded, but shape-scrubbed");
        assert_eq!(got[0]["turn"].as_str().unwrap(), "", "turn keys nothing, so it is emptied");
        // The observation survives — scrubbing a field must not cost the count.
        assert_eq!(got[0]["check"].as_str().unwrap(), "relay-paste");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A prose CHECK id is refused outright rather than scrubbed, because unlike a severity it would
    /// BECOME a row in the rollup — and a rollup keyed on prose is not a rollup.
    ///
    /// AND THE REFUSAL MUST NOT LEAK IT EITHER. roborev 55693 (Medium): refusing the record kept the
    /// prose out of the JSONL and then handed it to `tracing::warn!`, which writes the rolling daily
    /// log that `support.rs` UPLOADS — so the text left the device through the diagnostic that existed
    /// to report it being blocked. A privacy gate whose error message re-emits the value is not a gate.
    #[test]
    fn a_prose_check_id_is_refused_and_its_text_stays_out_of_the_diagnostic() {
        let dir = tmpdir("prosecheck");
        let prose = "relay paste of the message I sent Left Pair (probably)";
        let v = LintViolation { check: prose.to_string(), ..violation() };

        assert!(!record_violation(&dir, &v));
        let err = append_violation(&dir, &v).unwrap_err();
        assert!(err.contains("identifier-shaped"), "the diagnostic names the shape: {err}");
        assert!(!err.contains("Left Pair"), "and never the value: {err}");
        assert!(!err.contains("probably"));
        assert!(!lint_log_path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE ASSERTION THAT ACTUALLY GUARDS THE LEAK (roborev 55709, Medium).
    ///
    /// The test above cannot fail if the fix is reverted, and neither could anything else in this
    /// module. Its `!err.contains("Left Pair")` assertions are TAUTOLOGICAL for that path — the
    /// check-shape error never interpolated the value, before or after the fix — and
    /// `assert_eq!(loggable_id(prose), "<unshaped>")` tests the helper in isolation while the leak
    /// lived at the CALL SITE (`check = %clip(&v.check, …)`). So reverting the warn field would have
    /// restored 64 characters of unvalidated reply text into the daily file `support.rs` uploads, with
    /// all 26 tests green and no visible symptom — a privacy regression that is silent by
    /// construction. A mutation-check PASS on `loggable_id` does not close it either: that proves the
    /// helper's body is covered by a different test, which is exactly the line-scan false positive.
    ///
    /// So: capture the log and assert on what was actually emitted. This is the ONLY test in the
    /// module that turns red when the warn field is reverted.
    #[test]
    fn the_warn_field_itself_never_carries_the_refused_text() {
        use std::io::Write as _;
        use std::sync::{Arc, Mutex};

        /// A `MakeWriter` over a shared buffer, so the assertion reads real emitted output.
        #[derive(Clone)]
        struct Shared(Arc<Mutex<Vec<u8>>>);
        impl Write for Shared {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Shared {
            type Writer = Shared;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let buf = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(Shared(Arc::clone(&buf)))
            .with_ansi(false)
            .with_max_level(tracing::Level::WARN)
            .finish();

        let dir = tmpdir("warnfield");
        let prose = "relay paste of the message I sent Left Pair (probably)";
        tracing::subscriber::with_default(subscriber, || {
            // Both leak sites in one pass: a prose CHECK id and a prose ACTION.
            assert!(!record_violation(&dir, &LintViolation { check: prose.to_string(), ..violation() }));
            assert!(!record_violation(
                &dir,
                &LintViolation { action: prose.to_string(), ..violation() }
            ));
            // ...and a prose HASH, whose drop is also logged.
            assert!(record_violation(
                &dir,
                &LintViolation { hash: Some(prose.to_string()), ..violation() }
            ));
        });

        let logged = String::from_utf8_lossy(&buf.lock().unwrap_or_else(|e| e.into_inner())).to_string();
        assert!(!logged.is_empty(), "nothing was captured — the harness is broken, so this would \
             pass vacuously however the warn fields are written");
        for fragment in ["Left Pair", "probably", "relay paste of the message"] {
            assert!(
                !logged.contains(fragment),
                "the refused text {fragment:?} reached the uploadable log: {logged}"
            );
        }
        assert!(
            logged.contains("<unshaped>"),
            "the shape-only placeholder must be what got logged instead: {logged}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The unknown-action diagnostic must not echo the action either — it is arbitrary caller text on
    /// the same path to the same uploadable log.
    #[test]
    fn the_unknown_action_diagnostic_names_the_shape_not_the_value() {
        let dir = tmpdir("actiondiag");
        let prose = "I pasted the whole message back into the reply";
        let err = append_violation(&dir, &LintViolation { action: prose.to_string(), ..violation() })
            .unwrap_err();

        assert!(!err.contains("whole message"), "the value must not reach the log: {err}");
        assert!(err.contains("warned"), "but the ALLOWED set is useful and safe to name: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `loggable_id` must still pass a legitimate id through, or every diagnostic becomes useless.
    #[test]
    fn loggable_id_passes_a_real_identifier_through() {
        assert_eq!(loggable_id("relay-paste"), "relay-paste");
        assert_eq!(loggable_id("  hedge-words  "), "hedge-words");
        assert_eq!(loggable_id(&"c".repeat(500)).chars().count(), ID_MAX_CHARS);
        assert_eq!(loggable_id(""), "<unshaped>");
    }

    /// DRIFT PIN for the check ids. roborev 55693 (Medium): the identifier-shape rule is a constraint
    /// on a vocabulary this module deliberately does NOT own (`LINT_CHECK_IDS` in the TS store), and it
    /// had no detector — so the day someone adds a check id containing a space, `/`, `@` or `(`, every
    /// violation of that check would be DROPPED from the log with only a warn while
    /// `recordViolation` kept tallying it. That is the log-undercounts-the-counter failure that
    /// `SEVERITIES` names as the one that matters here. Pinned the same way `ACTIONS` is: read the
    /// authoritative list and assert this writer would accept every id in it.
    #[test]
    fn every_typescript_check_id_survives_the_identifier_shape_rule() {
        let ids =
            ts_string_array_in("../src/stores/conciergeLintMetrics.ts", "LINT_CHECK_IDS");
        assert!(ids.len() >= 10, "expected the plan's ten Tier-2 checks, got {}", ids.len());
        for id in &ids {
            assert!(
                is_identifier_shaped(id),
                "check id {id:?} is not identifier-shaped, so THIS WRITER WOULD DROP every violation \
                 of it while the session counter kept counting — either rename the check or relax \
                 is_identifier_shaped"
            );
            // ...and end to end: a violation naming it actually records.
            let dir = tmpdir("tscheckids");
            let v = LintViolation { check: id.clone(), ..violation() };
            assert!(record_violation(&dir, &v), "{id} must be loggable");
            assert_eq!(lines(&dir)[0]["check"].as_str().unwrap(), id);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// AN ABSURD COUNT MUST NOT REACH THE TOTAL. roborev 55671 (Medium): the coercion clamped with
    /// `.min(u32::MAX)`, so `count: 1e10` landed as 4_294_967_295 and the report summed it straight
    /// into `TOTAL` — one malformed payload inflating the all-time number by 4.29 billion, which is
    /// the single number this whole feature exists to make trustworthy. It was also a REGRESSION: the
    /// strict-typed command this replaced rejected a non-`u32` count at deserialization, losing the
    /// record but keeping the total honest.
    #[test]
    fn an_absurd_count_floors_to_one_rather_than_saturating_into_the_total() {
        let dir = tmpdir("bigcount");
        for absurd in [
            serde_json::json!(1e10),
            serde_json::json!(1e300),
            serde_json::json!(u32::MAX),
            serde_json::json!(i64::MAX),
            serde_json::json!(-5),
        ] {
            let v = violation_from_json(Some(&serde_json::json!({
                "ts": 1, "turn": "418", "check": "relay-paste",
                "severity": "block", "action": "revised", "count": absurd,
            })))
            .unwrap();
            assert_eq!(v.count, 1, "count {absurd} must floor, not clamp to the cap or saturate");
            assert!(record_violation(&dir, &v));
        }
        // And the same bound applies to a direct Rust caller, not only to the JSON path.
        let direct = LintViolation { count: u32::MAX, span: u32::MAX, ..violation() };
        assert!(record_violation(&dir, &direct));

        let total: u64 = lines(&dir).iter().map(|v| v["count"].as_u64().unwrap()).sum();
        assert_eq!(total, 6, "six violations must total six, whatever the payloads claimed");
        assert_eq!(lines(&dir).last().unwrap()["span"].as_u64().unwrap(), 0, "span is bounded too");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A control character in a field must not become a second line. Two lines would be read as two
    /// violations and inflate the very count this feature exists to make trustworthy.
    ///
    /// Now defended twice: the identifier-shape check rejects a newline before serialization, and
    /// `serde_json` would escape it anyway. Both are asserted, because either one alone is a single
    /// point of failure for the file's whole record-per-line contract.
    #[test]
    fn a_newline_in_a_field_cannot_split_the_record() {
        let dir = tmpdir("newline");
        record_violation(&dir, &LintViolation { turn: "4\n18".to_string(), ..violation() });

        let raw = std::fs::read_to_string(lint_log_path(&dir)).unwrap();
        assert_eq!(raw.lines().count(), 1, "one violation is one line: {raw:?}");
        assert!(!raw.contains("\\n"), "the shape check dropped it before escaping was needed: {raw}");
        assert_eq!(lines(&dir)[0]["turn"].as_str().unwrap(), "");

        // Belt and braces: serialization escapes a newline even where a field is not shape-checked.
        let serialized = serde_json::to_string(&LintViolation {
            action: "wa\nrned".to_string(),
            ..violation()
        })
        .unwrap();
        assert!(!serialized.contains('\n'), "a serialized record is always exactly one line");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// CONCURRENCY: many threads appending at once must produce whole, parseable lines — no
    /// interleaving mid-record. This is the property `O_APPEND` buys and the reason the writer does
    /// a single `write_all` rather than building the line incrementally.
    #[test]
    fn concurrent_appends_never_interleave_mid_line() {
        let dir = tmpdir("concurrent");
        const THREADS: usize = 8;
        const PER_THREAD: usize = 40;

        let handles: Vec<_> = (0..THREADS)
            .map(|t| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    for i in 0..PER_THREAD {
                        let v = LintViolation {
                            ts: Some((t * 1000 + i) as i64),
                            turn: format!("turn-{t}"),
                            // A long-ish digest per record, so a torn write would be obvious.
                            hash: Some(format!("{t}{}", "f".repeat(HASH_MAX_CHARS - 1))),
                            ..violation()
                        };
                        assert!(record_violation(&dir, &v));
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let got = lines(&dir); // panics on any partial line
        assert_eq!(got.len(), THREADS * PER_THREAD, "no record lost or split");
        for v in &got {
            assert_eq!(v["check"].as_str().unwrap(), "relay-paste");
            assert_eq!(v["hash"].as_str().unwrap().chars().count(), HASH_MAX_CHARS);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE CONTRACT WITH THE REPLY PATH: an unwritable sink is a warn, not an error and never a
    /// panic. A log that can throw into the render path is worse than no log.
    #[cfg(unix)]
    #[test]
    fn an_unwritable_dir_is_swallowed_rather_than_failing_the_caller() {
        use std::os::unix::fs::PermissionsExt;
        let root = tmpdir("unwritable");
        let locked = root.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();

        let wrote = record_violation(&locked, &violation());
        let core = append_violation(&locked, &violation());

        // Restore before asserting so a failure can't leave an undeletable temp dir behind.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&root);

        assert!(!wrote, "nothing was written");
        assert!(core.is_err(), "the fallible core reports why, so a failure is diagnosable");
        // The point of the test: `record_violation` returned normally. Reaching this line at all is
        // the assertion — a panic or an unwrap inside would have taken the caller down with it.
    }

    /// The parent dir is created on demand: the first violation of a fresh install must land, not
    /// be dropped because nothing had written to `<app_data>` yet.
    #[test]
    fn creates_the_app_data_dir_if_it_does_not_exist_yet() {
        let root = tmpdir("mkdir");
        let fresh = root.join("never-created");
        assert!(!fresh.exists());

        assert!(record_violation(&fresh, &violation()));

        assert_eq!(lines(&fresh).len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An unknown `action` is REFUSED, not filed under a plausible bucket — the rollup and the
    /// session counters both key on it, so a typo accepted as real corrupts the only number anyone
    /// reads. So is a record with no check id and one with no severity.
    #[test]
    fn a_record_missing_its_keys_or_naming_an_unknown_action_writes_nothing() {
        let dir = tmpdir("badenum");
        let bad_action = LintViolation { action: "fixed-probably".to_string(), ..violation() };
        let no_check = LintViolation { check: "   ".to_string(), ..violation() };
        let no_sev = LintViolation { severity: String::new(), ..violation() };

        assert!(!record_violation(&dir, &bad_action));
        assert!(!record_violation(&dir, &no_check));
        assert!(!record_violation(&dir, &no_sev));
        assert!(append_violation(&dir, &bad_action).unwrap_err().contains("action"));
        assert!(append_violation(&dir, &no_check).unwrap_err().contains("check"));
        assert!(append_violation(&dir, &no_sev).unwrap_err().contains("severity"));

        assert!(
            !lint_log_path(&dir).exists() || std::fs::read_to_string(lint_log_path(&dir)).unwrap().is_empty(),
            "a refused record must not put a line on disk"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every documented action and severity is accepted, so the action guard cannot overshoot into
    /// rejecting the vocabulary the linter actually emits.
    #[test]
    fn every_documented_action_and_severity_is_accepted() {
        let dir = tmpdir("goodenum");
        for action in ACTIONS {
            for severity in SEVERITIES {
                let v = LintViolation {
                    action: action.to_string(),
                    severity: severity.to_string(),
                    ..violation()
                };
                assert!(record_violation(&dir, &v), "{action}/{severity} must be loggable");
            }
        }
        assert_eq!(lines(&dir).len(), ACTIONS.len() * SEVERITIES.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An UNFAMILIAR severity is recorded, not refused. roborev 55656 (Medium): `[concierge.checks]`
    /// owns the severity names and lands in `config.rs`, so refusing an unknown one means that the
    /// day a fourth tier ships, every affected violation is dropped with only a `tracing::warn!`
    /// while the session counters keep counting it — the log would silently undercount against the
    /// number displayed beside it. The report buckets whatever string it gets, so an odd severity is
    /// VISIBLE. Visible-and-odd beats absent.
    #[test]
    fn an_unfamiliar_severity_is_recorded_so_the_log_cannot_undercount_the_counters() {
        let dir = tmpdir("newsev");
        let v = LintViolation { severity: "critical".to_string(), ..violation() };

        assert!(record_violation(&dir, &v), "an unknown tier must not cost us the observation");

        assert_eq!(lines(&dir)[0]["severity"].as_str().unwrap(), "critical");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// DRIFT DETECTOR for the one vocabulary that IS duplicated. roborev 55656 (Medium): `ACTIONS`
    /// restates `LINT_ACTIONS` from `stores/conciergeLintMetrics.ts`, and nothing kept them in step —
    /// so adding an action on the TS side would have refused every affected record here while the
    /// session counter went on counting it. Same idiom `roborev-cadence.test.sh` uses to pin a doc to
    /// a file: read the other side and assert set equality, so the drift fails the suite instead.
    /// Read a `export const NAME: readonly T[] = [ "a", "b" ] as const;` array out of the TS store.
    ///
    /// Delimits on the ARRAY BRACKETS, not on a `];` terminator: the declarations end `] as const;`,
    /// and the first version of this scanned for `];`, ran past the array, and swept up every quoted
    /// string in the rest of the file. It failed on its first run — which is a pin working, but note
    /// the failure mode: a too-greedy extractor fails for a reason that has nothing to do with drift.
    /// Anchored on `= [` rather than the first `[`, because the type annotation (`readonly T[]`) sits
    /// between the name and the initializer and its bracket would delimit an empty body.
    ///
    /// Takes the file RELATIVE to `src-tauri`, because there are two pinned vocabularies in two
    /// different TS modules now: the actions live with the session counters, the severities with the
    /// linter's own types.
    fn ts_string_array_in(rel: &str, name: &str) -> Vec<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
        let src = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let decl = src
            .find(&format!("export const {name}"))
            .unwrap_or_else(|| panic!("{rel} must export {name} for this pin"));
        let open = decl
            + src[decl..]
                .find("= [")
                .unwrap_or_else(|| panic!("{name} must be initialized with an array literal"))
            + 2;
        let close = open + src[open..].find(']').unwrap_or_else(|| panic!("{name} must be closed"));
        // Every double-quoted literal inside the array body is a member.
        let out: Vec<String> =
            src[open..close].split('"').skip(1).step_by(2).map(|s| s.to_string()).collect();
        assert!(
            !out.is_empty(),
            "extracted nothing from {name} — the parse is broken, which would make a set-equality \
             pin succeed vacuously the moment both sides read empty"
        );
        out
    }

    /// SAME-CRATE half of the severity pin: `config.rs` owns the vocabulary a user writes in
    /// `[concierge.checks]`, and this module restates it to bucket a violation without depending on
    /// the config layer. Direct constant comparison — same crate, so `pub(crate)` suffices and there
    /// is no extractor to get wrong.
    #[test]
    fn the_severity_vocabulary_matches_the_config_one() {
        let mut from_config: Vec<&str> = crate::config::CONCIERGE_CHECK_SEVERITIES.to_vec();
        from_config.sort_unstable();
        let mut from_log: Vec<&str> = SEVERITIES.to_vec();
        from_log.sort_unstable();
        assert_eq!(
            from_log, from_config,
            "the violation log's severity vocabulary has drifted from [concierge.checks] in \
             config.rs. Add the tier to BOTH, or the log will bucket a configured severity it \
             cannot name."
        );
    }

    /// CROSS-LANGUAGE half of the severity pin (roborev 55687). The same-crate pin above cannot see
    /// `conciergeLint/types.ts`, and that is the copy whose drift changes BEHAVIOUR rather than just
    /// types: `lintReply` treats `severity === "block"` as blocking and `=== "off"` as skip, so a
    /// tier both Rust constants know about but TypeScript does not would render a reply the user
    /// configured to be blocked.
    #[test]
    fn the_severity_vocabulary_matches_the_typescript_one() {
        let mut from_ts =
            ts_string_array_in("../src/services/conciergeLint/types.ts", "LINT_SEVERITIES");
        from_ts.sort();
        let mut from_rust: Vec<String> = SEVERITIES.iter().map(|s| s.to_string()).collect();
        from_rust.sort();

        assert_eq!(
            from_rust, from_ts,
            "the severity vocabulary has drifted between Rust and \
             services/conciergeLint/types.ts. A tier TypeScript has never heard of RENDERS instead \
             of blocking, so add it in all THREE places: config.rs, this file, and types.ts."
        );
    }

    #[test]
    fn the_action_vocabulary_matches_the_typescript_one() {
        let mut from_ts =
            ts_string_array_in("../src/stores/conciergeLintMetrics.ts", "LINT_ACTIONS");
        from_ts.sort();
        let mut from_rust: Vec<String> = ACTIONS.iter().map(|s| s.to_string()).collect();
        from_rust.sort();

        assert_eq!(
            from_rust, from_ts,
            "ACTIONS (Rust) and LINT_ACTIONS (TS) have drifted. An action the frontend emits but \
             this module does not know is REFUSED, so the on-disk log silently undercounts against \
             the session counters shown next to it. Update both."
        );
    }

    // -- the invoke payload ------------------------------------------------

    /// THE OUTER HALF OF "cannot fail the caller". roborev 55656 (Medium): the command used to take a
    /// strict `LintViolation`, and Tauri deserializes command arguments BEFORE the body runs — so a
    /// caller passing a float `ts`, a `Date`, an ISO string, or a stringified number got a REJECTED
    /// invoke promise out of the violation logger, which is the one failure this module exists to
    /// prevent, and no care inside the body could have caught it. The payload is coerced now.
    #[test]
    fn a_loosely_typed_payload_still_produces_a_usable_record() {
        // Every field in the shape a sloppy caller plausibly sends it: numbers where strings belong,
        // a float timestamp, a stringified count.
        let payload = serde_json::json!({
            "ts": 1_769_649_600_123.0_f64,
            "turn": 418,
            "check": "relay-paste",
            "severity": "block",
            "action": "revised",
            "count": "2",
            "span": 412.9,
            "hash": "a19f3c",
        });
        let v = violation_from_json(Some(&payload)).unwrap();
        assert_eq!(v.ts, Some(1_769_649_600_123));
        assert_eq!(v.turn, "418", "a numeric turn is read, not rejected");
        assert_eq!(v.count, 2);
        assert_eq!(v.span, 412, "a float span truncates rather than failing");

        // And it round-trips onto disk.
        let dir = tmpdir("payload");
        assert!(record_violation(&dir, &v));
        assert_eq!(lines(&dir)[0]["turn"].as_str().unwrap(), "418");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The degenerate payloads. None of these may panic, and none may produce a record — an absent
    /// argument is what a bug in the call site looks like, and `null`/a bare string is what a
    /// mis-shaped `invoke` looks like.
    #[test]
    fn a_junk_payload_is_refused_without_panicking() {
        for junk in [
            serde_json::Value::Null,
            serde_json::json!("relay-paste"),
            serde_json::json!(7),
            serde_json::json!([{"check": "relay-paste"}]),
        ] {
            assert!(violation_from_json(Some(&junk)).is_err(), "{junk} must not become a record");
        }
        assert!(violation_from_json(None).unwrap_err().contains("missing"));

        // An object missing the keys the rollup needs parses, then fails the vocabulary check.
        let dir = tmpdir("junkpayload");
        let empty = violation_from_json(Some(&serde_json::json!({}))).unwrap();
        assert!(!record_violation(&dir, &empty), "an empty object is not a violation");
        assert!(!lint_log_path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An unusable `ts` writes `null`, not a fabricated time and not a lost record. The report script
    /// treats a non-numeric `ts` as unplaceable (sorts it last, excludes it from `--since`), so this
    /// costs ordering for one row rather than an observation.
    #[test]
    fn an_unusable_timestamp_records_null_rather_than_dropping_the_violation() {
        let dir = tmpdir("nots");
        let payload = serde_json::json!({
            "ts": "2026-07-29T10:00:00Z", // an ISO string, not epoch ms
            "turn": "418",
            "check": "relay-paste",
            "severity": "block",
            "action": "revised",
        });
        let v = violation_from_json(Some(&payload)).unwrap();
        assert_eq!(v.ts, None);

        assert!(record_violation(&dir, &v));
        let raw = std::fs::read_to_string(lint_log_path(&dir)).unwrap();
        assert!(raw.contains("\"ts\":null"), "the key is present as null, never omitted: {raw}");
        assert_eq!(lines(&dir)[0]["check"].as_str().unwrap(), "relay-paste");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An older caller that omits `count`/`span` still records — the frontend and this module ship
    /// together in one binary, but the FILE outlives both, and a stricter reader would drop rows
    /// written by a previous version.
    #[test]
    fn count_and_span_default_when_a_caller_omits_them() {
        let v: LintViolation = serde_json::from_str(
            r#"{"ts":1,"turn":"7","check":"hedge-words","severity":"warn","action":"warned"}"#,
        )
        .unwrap();
        assert_eq!(v.count, 1, "one occurrence is the sane default, not zero");
        assert_eq!(v.span, 0);
        assert_eq!(v.hash, None);
        assert_eq!(v.ts, Some(1));

        // ...and the coercion path agrees, including on a non-positive count.
        let coerced = violation_from_json(Some(&serde_json::json!({
            "turn": "7", "check": "hedge-words", "severity": "warn", "action": "warned", "count": 0,
        })))
        .unwrap();
        assert_eq!(coerced.count, 1, "the violation happened at least once");
        assert_eq!(coerced.span, 0);

        // A DEFAULT MUST ONLY APPLY WHEN THE VALUE IS ABSENT OR NONSENSE. Without this the test was
        // vacuous on the line it covers (mutation-check FLAG): `0` collapses to `1` whether the
        // filter reads `> 0` or `< 0`, so only a real value proves the filter passes it through.
        let supplied = violation_from_json(Some(&serde_json::json!({
            "turn": "7", "check": "hedge-words", "severity": "warn", "action": "warned",
            "count": 7, "span": 240,
        })))
        .unwrap();
        assert_eq!(supplied.count, 7, "a real count must survive, not be replaced by the default");
        assert_eq!(supplied.span, 240);

        // NEGATIVE VALUES, which is where `span`'s predicate is actually decidable. roborev 55684
        // (Medium) asked for an explicit `"span": 0` case as well; that one CANNOT go red, because
        // supplied-zero and defaulted-zero are the same value — widening `0..=` to `1..=` produces
        // identical output, i.e. an equivalent mutant, not a behavior change. A negative value is the
        // boundary that distinguishes them: it must floor, not wrap into a huge u32.
        let negative = violation_from_json(Some(&serde_json::json!({
            "turn": "7", "check": "hedge-words", "severity": "warn", "action": "warned",
            "count": -3, "span": -1,
        })))
        .unwrap();
        assert_eq!(negative.count, 1);
        assert_eq!(negative.span, 0, "a negative span must floor, never wrap to ~4.29e9");
        // And an explicit zero span still reads as zero, so the floor cannot be doing it by accident.
        let zero = violation_from_json(Some(&serde_json::json!({
            "turn": "7", "check": "hedge-words", "severity": "warn", "action": "warned", "span": 0,
        })))
        .unwrap();
        assert_eq!(zero.span, 0);
    }
}
