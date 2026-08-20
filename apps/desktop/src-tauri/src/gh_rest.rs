//! Reading PR check state over GitHub's REST API, as a fallback for the GraphQL path.
//!
//! WHY THIS EXISTS. Every check-state read in this app goes through `gh pr list --json
//! …statusCheckRollup`, which is a GraphQL query. When GitHub's GraphQL endpoint degrades, that
//! call exits non-zero and the reader goes blind — `conflict_watch::probe_open_prs` returns
//! `Err("gh-failed")` and every open PR in the fleet reports as unreadable at once. Measured on
//! 2026-08-17: `gh pr list` failed 4 of 6 consecutive attempts with `HTTP 503 … api.github.com/
//! graphql` while REST answered normally throughout (42 open PRs in 1.9s). The two APIs fail
//! independently, which is the whole reason a fallback is worth having.
//!
//! THE RULE THIS MODULE IS BUILT AROUND: a fallback that silently degrades is worse than the bug
//! it patches. Every function here returns `None`/`Err` rather than a partial or defaulted answer,
//! because the caller's contract is that "we could not read this" and "the checks are red" must
//! never collapse into the same value.

use serde_json::{json, Value};

/// One open PR, as REST's pull-request list reports it.
///
/// Deliberately NOT a `PrFacts`: REST's list endpoint cannot supply `mergeable` or
/// `mergeable_state` (GitHub computes mergeability lazily and exposes it only on the single-PR
/// GET), so a type that carried those fields could not be filled honestly here. The caller decides
/// how to represent mergeability it did not read — see `conflict_watch::MERGE_STATE_UNKNOWN` —
/// rather than receiving a `false` this module invented.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RestPr {
    pub number: u64,
    pub title: String,
    pub branch: String,
    pub head_oid: String,
    pub base_oid: String,
    pub is_draft: bool,
    pub url: String,
    /// The PR author's login. REST has no `--author @me` equivalent on the list endpoint, so a
    /// caller that wants the GraphQL query's author scoping filters on this instead.
    pub author: String,
    /// GitHub's `updated_at`, verbatim. A change detector for callers that have one; empty when
    /// absent, which those callers read as always-changed rather than as unchanged.
    pub updated_at: String,
}

/// `GET /repos/{owner}/{repo}/pulls?state=open` → the open PRs.
///
/// `None` (never an empty vec) when the body is unparsable, keeping the null-vs-zero discipline the
/// rest of the codebase uses: an empty list means "this repo has no open PRs", and that is a claim
/// an unreadable body cannot support.
pub fn decode_pulls(body: &str) -> Option<Vec<RestPr>> {
    let rows = serde_json::from_str::<Vec<Value>>(body).ok()?;
    Some(rows.iter().filter_map(decode_pull).collect())
}

/// One REST pull row → `RestPr`. A row with no number is dropped rather than failing the whole
/// read, matching `conflict_watch::decode_pr_facts`.
fn decode_pull(r: &Value) -> Option<RestPr> {
    let number = r.get("number").and_then(Value::as_u64)?;
    let s = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let nested = |a: &str, b: &str| {
        r.get(a)
            .and_then(|v| v.get(b))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    Some(RestPr {
        number,
        title: s("title"),
        branch: nested("head", "ref"),
        head_oid: nested("head", "sha"),
        base_oid: nested("base", "sha"),
        is_draft: r.get("draft").and_then(Value::as_bool).unwrap_or(false),
        author: nested("user", "login"),
        updated_at: s("updated_at"),
        // REST calls it `html_url`; GraphQL calls it `url`. Same link.
        url: s("html_url"),
    })
}

/// A PR's checks, reconstructed from REST in the shape GraphQL's `statusCheckRollup` uses.
///
/// BOTH halves are required and that is the point of this function. GitHub reports checks through
/// two unrelated mechanisms and a rollup is the union of them:
///
///   * `GET /commits/{sha}/check-runs` → Actions jobs and most apps (`CheckRun`).
///   * `GET /commits/{sha}/status`     → legacy commit statuses (`StatusContext`). This repo's
///     `Vercel` check exists ONLY here, so a reader that skips this half silently loses it.
///
/// Verified against PR #2027 on 2026-08-17: the two together reproduce the GraphQL rollup exactly.
///
/// FAILS CLOSED ON A PARTIAL READ. If either body is unparsable the answer is `None`, never the
/// half that did parse. A half-read rollup is indistinguishable from a short one, so returning it
/// would let "the status half was unreachable" masquerade as "this PR has fewer checks" — and an
/// empty rollup is exactly what the callers read as "no check has ever run".
pub fn rollup_from_rest(check_runs_body: &str, status_body: &str) -> Option<Vec<Value>> {
    let mut out = normalize_check_runs(check_runs_body)?;
    out.extend(normalize_statuses(status_body)?);
    Some(out)
}

/// `GET /commits/{sha}/check-runs` → `CheckRun` rollup entries, case-normalized.
pub fn normalize_check_runs(body: &str) -> Option<Vec<Value>> {
    let runs = serde_json::from_str::<Value>(body)
        .ok()?
        .get("check_runs")?
        .as_array()?
        .clone();
    Some(runs.iter().map(normalize_check_run).collect())
}

/// `GET /commits/{sha}/status` → `StatusContext` rollup entries, case-normalized.
pub fn normalize_statuses(body: &str) -> Option<Vec<Value>> {
    let statuses = serde_json::from_str::<Value>(body)
        .ok()?
        .get("statuses")?
        .as_array()?
        .clone();
    Some(statuses.iter().map(normalize_status).collect())
}

fn normalize_check_run(c: &Value) -> Value {
    json!({
        "__typename": "CheckRun",
        "name": c.get("name").and_then(Value::as_str).unwrap_or(""),
        "status": upper(c.get("status")),
        // A queued run has `conclusion: null`, and it MUST stay null: the decoders read a
        // non-COMPLETED status as still-running, and a stringified "NULL" here would be read as an
        // unrecognised conclusion — i.e. as a failure — the moment anything looked at it directly.
        "conclusion": upper_or_null(c.get("conclusion")),
        "detailsUrl": c.get("details_url").and_then(Value::as_str).unwrap_or(""),
    })
}

fn normalize_status(s: &Value) -> Value {
    json!({
        "__typename": "StatusContext",
        "context": s.get("context").and_then(Value::as_str).unwrap_or(""),
        "state": upper(s.get("state")),
        "targetUrl": s.get("target_url").and_then(Value::as_str).unwrap_or(""),
    })
}

/// THE CASE TRAP, in one function.
///
/// REST answers in lowercase (`completed`, `success`, `failure`); GraphQL answers in UPPERCASE
/// (`COMPLETED`, `SUCCESS`, `FAILURE`); and every decoder in this codebase — `worktree::
/// check_state`, `scripts/pr-checks.sh`'s jq — matches the uppercase literals with a catch-all
/// `_ => Failing` arm. Feed those decoders a raw REST payload and a green `"success"` misses
/// `"SUCCESS"` and lands in the catch-all: **every passing check reads as failing.** That inverts
/// the one distinction this fallback exists to protect, so the normalization is not cosmetic
/// tidying — it is the correctness boundary between the two APIs.
fn upper(v: Option<&Value>) -> Value {
    match v.and_then(Value::as_str) {
        Some(s) => Value::String(s.to_ascii_uppercase()),
        None => Value::String(String::new()),
    }
}

/// As [`upper`], but preserves JSON null instead of flattening it to a string.
fn upper_or_null(v: Option<&Value>) -> Value {
    match v.and_then(Value::as_str) {
        Some(s) => Value::String(s.to_ascii_uppercase()),
        None => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `GET /commits/{sha}/check-runs` body, trimmed to the fields we read. Lowercase,
    /// because that is what REST actually sends — captured from PR #2027 on 2026-08-17.
    const REST_CHECK_RUNS: &str = r#"{"check_runs":[
        {"name":"Node — build","status":"completed","conclusion":"success","details_url":"https://x/1"},
        {"name":"Node — shell","status":"completed","conclusion":"failure","details_url":"https://x/2"},
        {"name":"Node — typecheck","status":"queued","conclusion":null,"details_url":"https://x/3"}
    ]}"#;

    /// The legacy-commit-status half. This repo's `Vercel` check lives ONLY here.
    const REST_STATUS: &str = r#"{"state":"success","statuses":[
        {"context":"Vercel","state":"success","target_url":"https://v/1"}
    ]}"#;

    /// `check_state`'s rules, as `worktree.rs` implements them, so these tests judge a normalized
    /// payload the way the shipping decoder would. Kept deliberately verbatim: if the two ever
    /// drift, the fallback is feeding the real decoder something it reads differently than this
    /// test claims.
    #[derive(Debug, PartialEq, Eq)]
    enum State {
        Passing,
        Pending,
        Failing,
    }
    fn check_state(c: &Value) -> State {
        if let Some(state) = c.get("state").and_then(Value::as_str) {
            return match state {
                "SUCCESS" => State::Passing,
                "PENDING" | "EXPECTED" => State::Pending,
                _ => State::Failing,
            };
        }
        if c.get("status").and_then(Value::as_str) != Some("COMPLETED") {
            return State::Pending;
        }
        match c.get("conclusion").and_then(Value::as_str).unwrap_or("") {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => State::Passing,
            _ => State::Failing,
        }
    }

    /// THE HEADLINE CASE TEST. A green REST check must read as PASSING once normalized.
    #[test]
    fn lowercase_rest_success_reads_as_passing() {
        let rollup = rollup_from_rest(REST_CHECK_RUNS, REST_STATUS).expect("both halves parse");
        let build = &rollup[0];
        assert_eq!(build["status"], "COMPLETED");
        assert_eq!(build["conclusion"], "SUCCESS");
        assert_eq!(check_state(build), State::Passing, "a green check must read green");
    }

    /// THE MUTATION GUARD for the test above: it pins that normalization is doing real work, by
    /// showing the RAW lowercase payload is misread by the very same decoder. Without this, a
    /// reviewer cannot tell the assertion above from one that would pass with `upper()` deleted.
    ///
    /// THE TWO HALVES ARE MISREAD DIFFERENTLY, and both are wrong in ways worth naming — the first
    /// draft of this test asserted a single outcome and was wrong about which:
    ///
    ///   * A `CheckRun` becomes **PENDING**, not failing. `check_state` tests `status !=
    ///     "COMPLETED"` BEFORE it looks at the conclusion, so lowercase `"completed"` misses that
    ///     literal and returns early. A finished, green PR then reads as permanently still-running:
    ///     never red, never mergeable, no error anywhere.
    ///   * A `StatusContext` becomes **FAILING**. It is matched on `state`, where lowercase
    ///     `"success"` misses `"SUCCESS"` and falls into the catch-all `_ => Failing`. This is the
    ///     green-into-red inversion, and this repo's `Vercel` check is exactly such a status.
    #[test]
    fn raw_lowercase_is_misread_by_the_shipping_decoder() {
        let raw_run = json!({"name":"Node — build","status":"completed","conclusion":"success"});
        assert_eq!(
            check_state(&raw_run),
            State::Pending,
            "un-normalized CheckRun: a FINISHED green check reads as still-running, forever"
        );

        let raw_status = json!({"context":"Vercel","state":"success"});
        assert_eq!(
            check_state(&raw_status),
            State::Failing,
            "un-normalized StatusContext: a PASSING check reads as FAILING — green inverted to red"
        );
    }

    /// A legacy commit status is carried through, and reads green. Losing this half would silently
    /// drop `Vercel` from every PR's rollup.
    #[test]
    fn legacy_status_context_survives_and_reads_green() {
        let rollup = rollup_from_rest(REST_CHECK_RUNS, REST_STATUS).unwrap();
        let vercel = rollup
            .iter()
            .find(|c| c["context"] == "Vercel")
            .expect("the StatusContext half must be present");
        assert_eq!(vercel["state"], "SUCCESS");
        assert_eq!(check_state(vercel), State::Passing);
    }

    /// A queued run keeps a NULL conclusion and reads as pending, not as a failure.
    #[test]
    fn queued_run_is_pending_not_failing() {
        let rollup = rollup_from_rest(REST_CHECK_RUNS, REST_STATUS).unwrap();
        let queued = rollup.iter().find(|c| c["name"] == "Node — typecheck").unwrap();
        assert!(queued["conclusion"].is_null(), "null must not become the string \"NULL\"");
        assert_eq!(check_state(queued), State::Pending);
    }

    /// A genuinely failing check still reads as failing — the fallback must not launder red into
    /// green any more than it laundered green into red.
    #[test]
    fn failing_check_still_reads_failing() {
        let rollup = rollup_from_rest(REST_CHECK_RUNS, REST_STATUS).unwrap();
        let shell = rollup.iter().find(|c| c["name"] == "Node — shell").unwrap();
        assert_eq!(check_state(shell), State::Failing);
    }

    /// FAILS CLOSED. One unreadable half yields no rollup at all, rather than the half that
    /// parsed — otherwise an unreachable status endpoint would present as "this PR has fewer
    /// checks", and an empty rollup is what callers read as "nothing has ever run".
    #[test]
    fn a_partial_read_is_no_read() {
        assert!(rollup_from_rest(REST_CHECK_RUNS, "504 Gateway Timeout").is_none());
        assert!(rollup_from_rest("<html>404</html>", REST_STATUS).is_none());
        assert!(rollup_from_rest("{}", REST_STATUS).is_none(), "a body missing check_runs is unreadable");
    }

    /// An empty rollup is a REAL answer (no check has run) and must survive as one — it is only
    /// the UNREADABLE case that has to vanish.
    #[test]
    fn genuinely_empty_rollup_is_readable_and_empty() {
        let rollup = rollup_from_rest(r#"{"check_runs":[]}"#, r#"{"statuses":[]}"#);
        assert_eq!(rollup, Some(vec![]));
    }

    #[test]
    fn pulls_decode_carries_the_fields_the_sweep_needs() {
        let body = r#"[
            {"number":2027,"title":"a title","draft":false,"html_url":"https://gh/2027",
             "user":{"login":"me"},"updated_at":"2026-08-17T00:00:00Z",
             "head":{"ref":"feature","sha":"aaaa1111"},"base":{"sha":"bbbb2222"}},
            {"title":"no number — dropped"}
        ]"#;
        let prs = decode_pulls(body).expect("parsable");
        assert_eq!(prs.len(), 1, "a numberless row is dropped, not fatal");
        assert_eq!(
            prs[0],
            RestPr {
                number: 2027,
                title: "a title".into(),
                branch: "feature".into(),
                head_oid: "aaaa1111".into(),
                base_oid: "bbbb2222".into(),
                is_draft: false,
                url: "https://gh/2027".into(),
                author: "me".into(),
                updated_at: "2026-08-17T00:00:00Z".into(),
            }
        );
    }

    /// Unparsable output is `None`, never `Some(vec![])` — "no open PRs" is a claim an unreadable
    /// body cannot support.
    #[test]
    fn unreadable_pulls_body_is_none_not_empty() {
        assert!(decode_pulls("503 Service Unavailable").is_none());
        assert_eq!(decode_pulls("[]"), Some(vec![]), "but a real empty list still reads empty");
    }
}
