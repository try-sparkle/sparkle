//! Sparkle's first OUTBOUND MCP client — the publish destination (bead `sparkle-131ms.4`).
//!
//! Host-side and direct, **never via a model**: saving a draft must not spend a Claude turn, and
//! the bearer token must never cross into the webview. Everything here is plain Rust; the Tauri
//! commands land with their callers (the configure probe in `sparkle-131ms.5`, the concierge tool
//! domain in `sparkle-131ms.6`), because a registered command with no caller is an ungated hole in
//! exactly the surface this epic exists to gate.
//!
//! ## The trap this module exists to close
//!
//! `https://drodio.com/api/mcp` reports **tool failures at HTTP 200**, with no JSON-RPC `error`
//! member, and the real status buried in a JSON **string** nested inside `content[0].text`:
//!
//! ```json
//! {"result":{"content":[{"type":"text","text":"{\"error\":\"Unauthorized\",\"status\":401}"}],
//!  "isError":true},"jsonrpc":"2.0","id":10}
//! ```
//!
//! A client that checks the HTTP status, or checks `response.error`, reads a **failed publish as a
//! successful one** — and then tells the founder their post is live when it is not. That is the
//! single worst outcome this feature can produce, so the decode is a pure function with its own
//! tests rather than a branch buried in a network call.
//!
//! ## Four rules verified against the live endpoint on 2026-08-17
//!
//! - **`Accept: application/json, text/event-stream` is MANDATORY** — both values. One of them
//!   alone fails every call with `-32000 Not Acceptable`. It is not in the MCP spec's prose as a
//!   hard requirement, so it reads as optional and is not.
//! - **Stateless.** No `Mcp-Session-Id` is issued or required, so each call stands alone and there
//!   is no handshake to keep warm. `initialize` is a *probe*, not a prerequisite.
//! - **`application/json` in practice**, but the server advertises `text/event-stream`, so the
//!   payload extractor tolerates SSE framing rather than assuming the shape that happens to arrive.
//! - **No redirect** on either the bare or trailing-slash URL form.

// Every item here is dead until `sparkle-131ms.5` (the capability probe) and `sparkle-131ms.6` (the
// concierge tool domain) call it. Landing the client separately is deliberate — its decoder is the
// load-bearing part and it gets its own review — but it means the compiler cannot see a caller yet.
// REMOVE THIS when PR 4 lands; a lingering module-wide allow would mask real rot later.
#![allow(dead_code)]

use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;
use url::Url;

/// Both values or nothing. Verified: sending only `application/json` fails `-32000 Not Acceptable`.
const ACCEPT: &str = "application/json, text/event-stream";

/// The protocol revision Sparkle asks for. The server's max is `2025-11-25` and it negotiates
/// **down**, so pinning an older revision is the conservative choice: it is the one whose shapes
/// this module's tests were written against, and a server that stops accepting it says so at
/// `initialize` rather than misbehaving mid-publish.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// Generous because a publish carries a whole article body upstream and waits on the destination's
/// own render. The connect timeout below is the one that keeps a dead host from hanging the caller.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

// ── Errors ────────────────────────────────────────────────────────────────────────────────────

/// Why a call to a publish destination did not produce a usable answer.
///
/// Typed rather than `String` because the caller acts differently on each: `Credential` routes to
/// the configure pane, `Tool` is the destination's own words and belongs in front of the user
/// verbatim, `Configuration` means stop and edit the URL, and `Transport` is the only one a retry
/// can fix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublishError {
    /// The destination refused or did not recognise the token. Reconfigure; retrying will not help.
    Credential(String),
    /// The tool ran and failed. Carries the destination's own message.
    Tool(String),
    /// The destination answered with something this client cannot act on.
    Protocol(String),
    /// The destination is MISCONFIGURED — the URL itself is wrong, or it points somewhere that
    /// redirects. Split out from `Transport` because `Transport` is the retryable class and this
    /// one will never succeed however many times it is tried; the fix is an edit to `config.toml`
    /// or the configure pane, and a caller that retries it instead loops forever.
    Configuration(String),
    /// Nothing usable came back — DNS, connect, TLS, timeout, or a 5xx. **The retryable class,
    /// and the only one.** A redirect used to live here and does not any more: it is
    /// `Configuration`, because retrying it just gets the same redirect.
    Transport(String),
}

impl PublishError {
    pub fn message(&self) -> &str {
        match self {
            Self::Credential(m)
            | Self::Tool(m)
            | Self::Protocol(m)
            | Self::Configuration(m)
            | Self::Transport(m) => m,
        }
    }
}

impl std::fmt::Display for PublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

// ── The pure decode path ──────────────────────────────────────────────────────────────────────

/// Pull the JSON-RPC payload out of a response body that may or may not be SSE-framed.
///
/// The endpoint answers `application/json` today, but advertises `text/event-stream` in the
/// `Accept` handshake it demands — so a future streaming answer is a contract change we already
/// agreed to. Framed bodies look like `event: message\ndata: {...}\n\n`. This takes the first
/// `data:` line carrying a JSON payload, which covers every answer the endpoint actually produces.
/// A JSON object split across several `data:` lines would NOT be reassembled — a stated limit,
/// not an oversight: the server answers `application/json`, so this whole path is tolerance for a
/// shape it advertises and has never sent.
fn extract_json_payload(body: &str) -> &str {
    let trimmed = body.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return trimmed;
    }
    // Not JSON at the top level. If it is SSE framing, the payload is on the `data:` lines — but
    // the FIRST one is not necessarily the answer. MCP's streamable-HTTP transport puts
    // server→client notifications (`notifications/progress` and friends) on the stream ahead of
    // the response, and those are JSON objects too. Taking the first JSON-looking line would hand
    // a progress notification to the envelope decoder, which would then report a perfectly healthy
    // publish as "not speaking JSON-RPC 2.0". So: return the first payload that actually carries a
    // `result` or an `error`.
    let mut first_json: Option<&str> = None;
    for line in trimmed.lines() {
        let Some(rest) = line.strip_prefix("data:") else {
            continue;
        };
        let rest = rest.trim();
        if !(rest.starts_with('{') || rest.starts_with('[')) {
            continue;
        }
        if first_json.is_none() {
            first_json = Some(rest);
        }
        if let Ok(v) = serde_json::from_str::<Value>(rest) {
            if v.get("result").is_some() || v.get("error").is_some() {
                return rest;
            }
        }
    }
    // Nothing answered. Fall back to the first JSON payload so the envelope decoder's message is
    // about what the server actually sent, rather than about the raw frame.
    first_json.unwrap_or(trimmed)
}

/// Unwrap a JSON-RPC envelope to its `result` — **and apply the `isError` rule here**, so that
/// every path through this module gets it rather than only the one that remembered to ask.
///
/// The `isError` check used to live in `decode_tool_result` alone. That was a hole in exactly the
/// place the module exists to plug: `initialize` is documented as the cheapest call that proves the
/// URL, the token and the protocol all work together, and an `isError` answer decoded as `Ok`,
/// so the one call whose job is to detect a bad credential reported it as a working destination.
/// `tools/list` was worse than useless — an unauthorized answer has no `tools` array, so it
/// surfaced as "this may not be an MCP server", sending the user to re-check a URL that was fine.
/// One definition, applied at the funnel every path goes through.
///
/// A real `error` member only ever comes back for an unknown *method* (`-32601`); tool failures
/// take the `isError` path. Both are handled, because a client that handles only the shape it
/// happened to observe reports the other as success.
///
/// **`null` is not "present".** `v.get("error")` answers `Some(Value::Null)` for the common (if
/// non-conformant) `"error": null` spelling that some servers emit *alongside* a valid result —
/// which without the filter below turns a SUCCESSFUL publish into a protocol error. The mirror
/// case, `{"result": null}`, would otherwise decode as `Ok("")`: a successful publish with an
/// empty answer. The module was already careful that absent means false for `isError`; these two
/// members needed the same care.
pub fn decode_rpc_envelope(body: &str) -> Result<Value, PublishError> {
    let payload = extract_json_payload(body);
    let v: Value = serde_json::from_str(payload).map_err(|e| {
        PublishError::Protocol(format!(
            "the destination did not answer with JSON ({e}). This usually means the URL names a \
             web page rather than an MCP endpoint."
        ))
    })?;

    if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
        let code = err.get("code").and_then(Value::as_i64);
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("no message");
        return Err(PublishError::Protocol(match code {
            Some(-32601) => format!(
                "the destination does not implement that MCP method ({message}). Its tool set may \
                 be older than the one Sparkle expects."
            ),
            Some(c) => format!("the destination returned JSON-RPC error {c}: {message}"),
            None => format!("the destination returned a JSON-RPC error: {message}"),
        }));
    }

    let result = v
        .get("result")
        .filter(|r| !r.is_null())
        .cloned()
        .ok_or_else(|| {
            PublishError::Protocol(
                "the destination's answer had neither a `result` nor an `error` — it is not \
                 speaking JSON-RPC 2.0"
                    .to_string(),
            )
        })?;

    // The module's central invariant, applied once for every caller. Absent means false, per the
    // MCP spec — only an explicit `true` is a failure.
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(tool_failure(&content_text(&result)));
    }
    Ok(result)
}

/// Concatenate the text parts of an MCP `content` array. Non-text parts are skipped rather than
/// stringified: a caller wants the destination's words, not a debug dump of an image blob.
fn content_text(result: &Value) -> String {
    result
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Turn an `isError` payload into a typed failure.
///
/// The destination nests its real status as a **JSON string** inside the text part, so the status
/// is two parses deep. When that inner value is not JSON it is a human-readable message and is
/// passed through verbatim — the destination's own words beat anything this module could invent.
fn tool_failure(text: &str) -> PublishError {
    let Ok(inner) = serde_json::from_str::<Value>(text) else {
        return PublishError::Tool(if text.is_empty() {
            "the destination reported a failure but said nothing about why".to_string()
        } else {
            text.to_string()
        });
    };

    let message = inner
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| inner.get("message").and_then(Value::as_str))
        .unwrap_or(text);

    match inner.get("status").and_then(Value::as_u64) {
        // 401/403 are the credential itself; 402 is a scope/plan refusal. All three are settings
        // problems, and all three are things a retry cannot fix.
        Some(401) | Some(402) | Some(403) => PublishError::Credential(format!(
            "the destination rejected the credential ({message}). Reconnect the destination in \
             Settings — the token may be revoked, or it may not hold the `content:publish` scope, \
             which `content:write` does not imply."
        )),
        Some(404) => PublishError::Credential(format!(
            "the destination did not recognise this token or the thing it named ({message}). \
             Either the token is unknown to it, or the post id no longer exists."
        )),
        Some(status) => PublishError::Tool(format!("the destination refused ({status}): {message}")),
        None => PublishError::Tool(message.to_string()),
    }
}

/// **The load-bearing decode.** A `tools/call` answer, or a typed failure.
///
/// The whole reason this is a named, separately tested function: HTTP 200 with `isError: true` is
/// a FAILURE, and every naive shape of this code — check the status, check `.error`, check that a
/// body came back — reports it as a success.
pub fn decode_tool_result(body: &str) -> Result<String, PublishError> {
    // The `isError` rule is applied by decode_rpc_envelope, so it holds for tools/list and
    // initialize too — not only for the path that remembered to check.
    Ok(content_text(&decode_rpc_envelope(body)?))
}

/// One tool as the destination describes it. `required_args` is what makes a capability probe
/// meaningful: two destinations can both expose `create_content` and mean different things by it,
/// so the contract Sparkle pins is the argument shape, not the name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub required_args: Vec<String>,
}

/// Decode a `tools/list` answer.
pub fn decode_tools_list(body: &str) -> Result<Vec<ToolDescriptor>, PublishError> {
    let result = decode_rpc_envelope(body)?;
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            PublishError::Protocol(
                "the destination's tools/list answer had no `tools` array — it may not be an MCP \
                 server"
                    .to_string(),
            )
        })?;

    Ok(tools
        .iter()
        .filter_map(|t| {
            let name = t.get("name").and_then(Value::as_str)?;
            let required_args = t
                .get("inputSchema")
                .and_then(|s| s.get("required"))
                .and_then(Value::as_array)
                .map(|r| {
                    r.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            Some(ToolDescriptor {
                name: name.to_string(),
                description: t
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                required_args,
            })
        })
        .collect())
}

// ── The pure request path ─────────────────────────────────────────────────────────────────────

fn rpc_request_body(id: u64, method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

/// Every header a destination request carries, in one place.
///
/// A function rather than three `.set()` calls at the call site so the mandatory-`Accept` rule is
/// testable: this is the seam production actually uses, so deleting a header here reds a test.
/// It is also the one place the token appears — deliberately, so "the bearer never leaks into a
/// URL, a body, or a log line" is a property of the code's shape rather than of vigilance.
fn headers(token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("Accept", ACCEPT.to_string()),
        ("Content-Type", "application/json".to_string()),
        ("Authorization", format!("Bearer {token}")),
    ]
}

/// A 3xx must fail BEFORE the body is read.
///
/// Two separate clauses are needed and the second is not implied by the first. This tree pins
/// `ureq 2.12.1`, where `redirects(0)` **returns the redirect response as `Ok`** rather than
/// erroring — so without this check a 302 falls through to the JSON parse and reports as a
/// protocol failure, hiding the real cause. And following it would be worse than useless: the
/// target is chosen by the server, and we are carrying a bearer token.
fn refuse_redirect(status: u16) -> Result<(), PublishError> {
    if (300..400).contains(&status) {
        return Err(PublishError::Configuration(format!(
            "the destination answered {status}, a redirect. Sparkle does not follow redirects while \
             carrying your token, because the destination chooses where it points. Set the \
             destination's URL to the endpoint it redirects to."
        )));
    }
    Ok(())
}

/// Map a non-2xx HTTP status to a typed failure. Split out from the network call so the mapping is
/// unit-testable — these are the statuses the live endpoint was verified to produce.
fn classify_http_status(status: u16, body: &str) -> PublishError {
    let detail = body.trim();
    let detail = if detail.is_empty() {
        String::new()
    } else {
        // Bound it: an HTML error page would otherwise put a whole document in a toast.
        format!(" ({})", detail.chars().take(200).collect::<String>())
    };
    match status {
        401 => PublishError::Credential(format!(
            "the destination rejected the token{detail}. Reconnect it in Settings — note that only \
             the `Bearer` scheme is accepted."
        )),
        402 | 403 => PublishError::Credential(format!(
            "the destination accepted the token but refused the action{detail}. It most likely \
             lacks the `content:publish` scope, which `content:write` does not imply."
        )),
        404 => PublishError::Credential(format!(
            "the destination answered 404{detail} — either it does not recognise this token, or \
             the URL does not name its MCP endpoint."
        )),
        406 => PublishError::Protocol(format!(
            "the destination refused the request's content negotiation{detail}. This is a Sparkle \
             bug, not a configuration problem."
        )),
        s if (500..600).contains(&s) => PublishError::Transport(format!(
            "the destination had a server error ({s}){detail}. This one is worth retrying."
        )),
        s => PublishError::Protocol(format!("the destination answered {s}{detail}")),
    }
}

// ── The network path ──────────────────────────────────────────────────────────────────────────

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            // Clause 1 of two. See refuse_redirect for why clause 2 is not optional.
            .redirects(0)
            .build()
    })
}

/// Re-validate the configured URL **at call time**, not only when it was configured.
///
/// `config.toml` is a text file on disk. A hand edit — or a sync from another machine, or a
/// restored backup — routes around every check the configure pane made. This is the last gate
/// before a bearer token goes on the wire, so it is the one that has to hold.
fn endpoint(raw: &str) -> Result<Url, PublishError> {
    crate::publish_url::validate_destination_url(raw).map_err(PublishError::Configuration)
}

/// Reading the response body: the text, or why it could not be read.
type ReadResult = Result<String, String>;

/// What a sender hands back: the status plus the RAW read, or a transport failure.
///
/// A 4xx/5xx is `Ok((status, ...))`, not an error — the STATUS is the answer, and every routing
/// decision belongs to `post_json_with`, where a test can drive it.
///
/// **The read is handed back UNRESOLVED, and that is the whole point of this type.** An earlier
/// revision resolved it inside the sender, which put the "an unreadable 2xx is a retryable failure"
/// decision below the injection seam — so re-applying the original regression at that one line left
/// every test green, because no test drives the sender. Passing the `Result` through means the fake
/// can push an unreadable body into the real decision point.
type SendResult = Result<(u16, ReadResult), String>;

/// Put the request on the wire. **The one function in this module no test can drive** — it needs a
/// real socket — so everything that could be decided elsewhere has been moved elsewhere: the URL,
/// the timeout and the headers are applied by `post_json_with`, and what to make of the answer is
/// `normalize_response`'s job.
///
/// What remains is one `into_string().map_err(...)`, and it is deliberately **one** rather than one
/// per arm. Choosing `map_err` over `unwrap_or_default` there IS a decision — it is the exact line
/// whose silent reversion turned a retryable read failure into an unretryable protocol fault — and
/// a decision made twice at an untestable boundary is two chances to get it wrong with nothing
/// watching. Folding both arms first leaves a single site, which
/// `the_transport_never_swallows_an_unreadable_body` then guards at the source level. That guard is
/// a weaker kind of test (it pins text, not behaviour) and it exists only because the stronger kind
/// is unavailable here: every behavioural test injects its own sender, so re-applying the original
/// bug on this line leaves all of them green.
fn send_over_network(req: ureq::Request, body: &str) -> SendResult {
    // ureq turns >= 400 into an Err. It is still an answer, so both arms fold into one shape and
    // the read happens ONCE below — see the note above about why one is the important number here.
    let (status, resp) = match req.send_string(body) {
        Ok(resp) => (resp.status(), resp),
        Err(ureq::Error::Status(status, resp)) => (status, resp),
        Err(ureq::Error::Transport(t)) => {
            return Err(format!("could not reach the destination: {t}"))
        }
    };
    Ok((status, resp.into_string().map_err(|e| e.to_string())))
}

/// Turn "the status, and whatever reading the body produced" into a `SendResult`.
///
/// **Split out from `send_over_network` because it is a DECISION, and the previous revision hid it
/// inside the one function no test can drive.** That is not hypothetical: this exact rule was
/// silently reverted to `unwrap_or_default()` during the seam refactor, and the test that claimed
/// to cover it injected a fake sender which *already returned* the error — so it asserted only the
/// `map_err` pass-through one layer up, and held identically against the broken code. Supplying the
/// outcome you then assert is this repo's named vacuous shape; the fix is a seam the test can push
/// a real unreadable body through, not a better-worded assertion.
///
/// The two arms are deliberately asymmetric:
///
/// - **A 2xx whose body cannot be READ is a `Transport` failure, not an empty success.** A
///   connection dropped mid-read is entirely possible inside the 30-second publish window. Treating
///   it as `Ok((200, ""))` sends it downstream to die as `Protocol("did not answer with JSON")` —
///   a **retryable** failure reported as an unretryable one, pointing the user at the destination's
///   JSON instead of at the dropped connection.
/// - **An error page whose body cannot be read is NOT itself a failure.** `classify_http_status`
///   works from the status; a missing detail string only makes its message shorter.
fn normalize_response(status: u16, read: ReadResult) -> Result<(u16, String), String> {
    match read {
        Ok(text) => Ok((status, text)),
        Err(e) if status < 400 => Err(format!("the destination's answer was unreadable: {e}")),
        Err(_) => Ok((status, String::new())),
    }
}

/// Build the request and decide everything about the answer, with the transport injected.
///
/// The seam exists because the alternative is the shape this repo names explicitly: a production
/// call site no test can reach, where deleting `refuse_redirect(...)` — or the header loop, or the
/// status routing — leaves the entire suite green. Testing `refuse_redirect` in isolation proves
/// the FUNCTION works and says nothing about whether the path that must call it still does.
///
/// **The header loop lives HERE, above the seam, deliberately.** A first revision put it inside the
/// sender, which meant the test could only prove that `headers()` *returns* the mandatory `Accept`
/// — not that it reaches the request. That is the same untested-call-site shape one layer down, and
/// it is not hypothetical: the body-read regression documented above slipped into exactly that
/// blind spot and was caught by review rather than by a test.
///
/// What is still NOT covered, stated rather than glossed: `ureq::Request` exposes no reader for its
/// timeout, so `HTTP_TIMEOUT` being applied is checked by nothing here.
fn post_json_with(
    send: &dyn Fn(ureq::Request, &str) -> SendResult,
    url: &Url,
    token: &str,
    body: &str,
) -> Result<String, PublishError> {
    let mut req = agent().post(url.as_str()).timeout(HTTP_TIMEOUT);
    for (name, value) in headers(token) {
        req = req.set(name, &value);
    }
    let (status, read) = send(req, body).map_err(PublishError::Transport)?;
    // **No FINAL HTTP answer has a status below 200.** Below 100 is not a status at all — the
    // transport fabricated it rather than reporting a failure. And 1xx is *interim* by definition
    // (RFC 9110 §15.2): a 1xx is not a final response, a final status still follows, and its body
    // is not the answer. Handing a 1xx body to the caller produces exactly the fault this check
    // exists to prevent, one range over: `Ok("")` → `Protocol("did not answer with JSON")`, an
    // UNRETRYABLE report of a transport that never delivered an answer. So the floor is 200, not
    // 100 — an earlier revision drew it at 100 and a test then pinned "a 1xx is a success whose
    // body reaches the caller" as though it were intent.
    //
    // Rejecting this is decidable and
    // behaviourally testable — unlike the source-shape checks this replaced, which tried to prove
    // a CONTROL-FLOW property (that every path through the transport arm diverges) by string
    // matching, and fell to a new construction every round.
    //
    // **What this does NOT close, stated rather than implied:** a fabrication carrying a plausible
    // status. `(200, Ok(""))` from a synthesized response is indistinguishable *here* from a real
    // empty 200, so no work at this layer recovers it — it is a genuine known limit, not a gap
    // waiting to be hardened. Status 0 is the spelling every fabrication actually chased used,
    // because a failed request has no status to copy.
    if status < 200 {
        // The message names the STATUS and says "final", because the predicate covers two
        // different situations and a single flat sentence is false for one of them: below 100 is
        // not a status at all (a fabrication), while 1xx is a perfectly valid status that simply
        // is not a final answer. An earlier revision widened the predicate from `< 100` to `< 200`
        // and left the wording at "no valid HTTP status", which then lied to anyone who hit a
        // genuine interim response.
        return Err(PublishError::Transport(format!(
            "the destination did not deliver a final answer (HTTP status {status}). Below 200 is \
             either not a status at all — a response the transport synthesized rather than \
             received — or an interim 1xx, which by definition is followed by the real answer. \
             Either way nothing was answered, and that is retryable."
        )));
    }
    // ABOVE the seam, deliberately — see SendResult. Below it, re-applying the original regression
    // at one line left every test green.
    let (status, text) = normalize_response(status, read).map_err(PublishError::Transport)?;
    // Before anything looks at the body, deliberately: a redirect's body is not ours to parse.
    refuse_redirect(status)?;
    if status >= 400 {
        return Err(classify_http_status(status, &text));
    }
    Ok(text)
}

/// The production wiring: one line, naming the real sender.
fn post_json(url: &Url, token: &str, body: &str) -> Result<String, PublishError> {
    post_json_with(&send_over_network, url, token, body)
}

/// One request, one POST, one answer.
///
/// The `id` is a fixed constant per method rather than a counter, and that is safe *here* only
/// because the transport is one self-contained request per connection — there is no multiplexing,
/// so there is no answer to correlate, and nothing on this path can receive someone else's reply.
/// JSON-RPC requires the field; nothing in this module validates the one that comes back. **If a
/// batching or streaming transport is ever added, this becomes a real correlation id and the
/// answer's `id` has to be checked against it** — and `extract_json_payload` already tolerates SSE
/// framing, which is the direction that would invalidate this. (Restored: the seam refactor sliced
/// this comment out as a passenger, and it is the only record of the precondition.)
fn rpc(
    raw_url: &str,
    token: &str,
    id: u64,
    method: &str,
    params: Value,
) -> Result<String, PublishError> {
    let url = endpoint(raw_url)?;
    post_json(&url, token, &rpc_request_body(id, method, params))
}

/// Handshake with the destination and report what it says it is.
///
/// Not a prerequisite — the endpoint is stateless, so `tools/list` and `tools/call` stand alone.
/// This exists for the configure pane: it is the cheapest call that proves the URL, the token and
/// the protocol revision all work together, without side effects.
pub fn initialize(raw_url: &str, token: &str) -> Result<Value, PublishError> {
    let params = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "sparkle", "version": env!("CARGO_PKG_VERSION") },
    });
    let body = rpc(raw_url, token, 1, "initialize", params)?;
    decode_rpc_envelope(&body)
}

pub fn list_tools(raw_url: &str, token: &str) -> Result<Vec<ToolDescriptor>, PublishError> {
    let body = rpc(raw_url, token, 2, "tools/list", json!({}))?;
    decode_tools_list(&body)
}

/// Call a tool. The returned `String` is the destination's text answer; a tool that failed is an
/// `Err`, including — especially including — one that failed at HTTP 200.
pub fn call_tool(
    raw_url: &str,
    token: &str,
    name: &str,
    arguments: Value,
) -> Result<String, PublishError> {
    let params = json!({ "name": name, "arguments": arguments });
    let body = rpc(raw_url, token, 3, "tools/call", params)?;
    decode_tool_result(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact payload captured from `https://drodio.com/api/mcp` on 2026-08-17. Copied verbatim
    /// rather than hand-built, because a hand-built fixture tests the shape you already believe in.
    const CAPTURED_401: &str = r#"{"result":{"content":[{"type":"text","text":"{\"error\":\"Unauthorized\",\"status\":401}"}],"isError":true},"jsonrpc":"2.0","id":10}"#;

    // ── The trap ──────────────────────────────────────────────────────────────────────────────

    /// **The test this whole module exists for.** HTTP 200, no JSON-RPC `error`, a well-formed
    /// `result` with real content — every naive success check passes this, and every one of them
    /// would tell the founder a failed publish succeeded.
    #[test]
    fn a_tool_failure_arriving_at_http_200_is_not_a_success() {
        let decoded = decode_tool_result(CAPTURED_401);
        assert!(
            decoded.is_err(),
            "a 200 carrying isError:true decoded as SUCCESS: {decoded:?}"
        );
    }

    /// …and it is specifically a CREDENTIAL failure, which is what routes the user to Settings.
    /// Classifying it as `Tool` or `Transport` would send them to retry a call that can never work.
    #[test]
    fn the_captured_401_routes_to_the_credential_pane_rather_than_a_retry() {
        match decode_tool_result(CAPTURED_401) {
            Err(PublishError::Credential(m)) => {
                assert!(m.contains("Unauthorized"), "lost the destination's words: {m}");
                assert!(m.contains("Settings"), "did not say where to fix it: {m}");
            }
            other => panic!("expected a Credential failure, got {other:?}"),
        }
    }

    /// The nested status is two parses deep — a JSON string inside a JSON string. A decoder that
    /// reads only the outer layer sees an opaque blob and cannot tell 404 from 500.
    #[test]
    fn a_404_inside_the_nested_text_is_read_as_an_unknown_token() {
        let body = r#"{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"{\"error\":\"Not Found\",\"status\":404}"}],"isError":true}}"#;
        assert!(matches!(
            decode_tool_result(body),
            Err(PublishError::Credential(_))
        ));
    }

    /// A scope refusal. `content:write` does not imply `content:publish`, so this is the shape a
    /// half-scoped token produces at the one moment it matters — the publish itself.
    #[test]
    fn a_403_names_the_scope_that_write_does_not_imply() {
        let body = r#"{"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"{\"error\":\"Forbidden\",\"status\":403}"}],"isError":true}}"#;
        match decode_tool_result(body) {
            Err(PublishError::Credential(m)) => {
                assert!(m.contains("content:publish"), "did not name the scope: {m}")
            }
            other => panic!("expected Credential, got {other:?}"),
        }
    }

    /// Not every failure nests JSON. When it does not, the destination's plain words are what the
    /// user should see — inventing a message here would bury the only real information available.
    #[test]
    fn a_plain_text_failure_passes_the_destinations_own_words_through() {
        let body = r#"{"jsonrpc":"2.0","id":6,"result":{"content":[{"type":"text","text":"title must be 180 characters or fewer"}],"isError":true}}"#;
        match decode_tool_result(body) {
            Err(PublishError::Tool(m)) => assert_eq!(m, "title must be 180 characters or fewer"),
            other => panic!("expected Tool, got {other:?}"),
        }
    }

    /// An `isError` with nothing to say still has to fail. Falling back to `Ok("")` here is the
    /// same bug as the 200 trap, one layer in.
    #[test]
    fn an_is_error_with_no_content_still_fails() {
        let body = r#"{"jsonrpc":"2.0","id":7,"result":{"content":[],"isError":true}}"#;
        assert!(decode_tool_result(body).is_err());
    }

    // ── The converse: success must still decode as success ────────────────────────────────────

    /// Without this, "return Err unconditionally" passes every test above.
    #[test]
    fn a_successful_call_returns_the_destinations_text() {
        let body = r#"{"jsonrpc":"2.0","id":8,"result":{"content":[{"type":"text","text":"{\"id\":\"c_42\",\"previewUrl\":\"https://drodio.com/p/secret\"}"}],"isError":false}}"#;
        let text = decode_tool_result(body).expect("a successful call must decode as Ok");
        assert!(text.contains("previewUrl"), "lost the payload: {text}");
    }

    /// `isError` is optional in MCP and absent means false. Treating absent as a failure would make
    /// every successful call from a spec-compliant server look like an error.
    #[test]
    fn an_absent_is_error_key_is_a_success() {
        let body = r#"{"jsonrpc":"2.0","id":9,"result":{"content":[{"type":"text","text":"ok"}]}}"#;
        assert_eq!(decode_tool_result(body).as_deref(), Ok("ok"));
    }

    /// Several text parts are joined, and a non-text part is skipped rather than debug-dumped.
    #[test]
    fn several_text_parts_are_joined_and_non_text_parts_are_skipped() {
        let body = r#"{"jsonrpc":"2.0","id":9,"result":{"content":[{"type":"text","text":"one"},{"type":"image","data":"AAAA"},{"type":"text","text":"two"}]}}"#;
        assert_eq!(decode_tool_result(body).as_deref(), Ok("one\ntwo"));
    }

    // ── The envelope ──────────────────────────────────────────────────────────────────────────

    /// The one case that DOES produce a real JSON-RPC `error` member: an unknown method. Handled
    /// alongside `isError` because a client that handles only the shape it happened to observe
    /// reports the other as success.
    #[test]
    fn a_jsonrpc_error_member_is_an_error_and_names_the_cause() {
        let body = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}"#;
        match decode_rpc_envelope(body) {
            Err(PublishError::Protocol(m)) => {
                assert!(m.contains("does not implement"), "unhelpful message: {m}")
            }
            other => panic!("expected Protocol, got {other:?}"),
        }
    }

    #[test]
    fn an_answer_with_neither_result_nor_error_is_a_protocol_failure() {
        assert!(matches!(
            decode_rpc_envelope(r#"{"jsonrpc":"2.0","id":1}"#),
            Err(PublishError::Protocol(_))
        ));
    }

    /// The most likely real-world misconfiguration: the URL names a web page, so the body is HTML.
    /// The message has to say that, or the user re-checks their token instead of their URL.
    #[test]
    fn an_html_body_names_the_likely_cause_rather_than_a_parse_error() {
        match decode_rpc_envelope("<!doctype html><html><body>Not found</body></html>") {
            Err(PublishError::Protocol(m)) => {
                assert!(m.contains("web page"), "did not name the cause: {m}")
            }
            other => panic!("expected Protocol, got {other:?}"),
        }
    }

    /// The server advertises `text/event-stream` in the Accept it demands, so a framed answer is a
    /// shape we already agreed to accept. It must decode identically to the bare one.
    #[test]
    fn an_sse_framed_body_decodes_identically_to_a_bare_one() {
        let framed = format!("event: message\ndata: {CAPTURED_401}\n\n");
        assert_eq!(decode_tool_result(&framed), decode_tool_result(CAPTURED_401));
        assert!(decode_tool_result(&framed).is_err(), "and still fails");
    }

    // ── tools/list ────────────────────────────────────────────────────────────────────────────

    /// The capability probe pins ARGUMENT SHAPES, not names — two destinations can both expose
    /// `create_content` and mean different things by it. A decoder that returns names only cannot
    /// support that check at all, so the required-args extraction is asserted here, not in PR 4.
    #[test]
    fn tools_list_carries_required_args_not_just_names() {
        let body = r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"create_content","description":"Create a draft","inputSchema":{"type":"object","properties":{"title":{},"projectId":{}},"required":["title","projectId"]}},{"name":"list_projects","description":"List projects","inputSchema":{"type":"object"}}]}}"#;
        let tools = decode_tools_list(body).expect("must decode");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "create_content");
        assert_eq!(
            tools[0].required_args,
            vec!["title".to_string(), "projectId".to_string()],
            "the projectId requirement is the correction that made list_projects mandatory"
        );
        assert!(
            tools[1].required_args.is_empty(),
            "a schema with no `required` is no required args, not a decode failure"
        );
    }

    #[test]
    fn a_tools_list_answer_with_no_tools_array_is_a_protocol_failure() {
        assert!(matches!(
            decode_tools_list(r#"{"jsonrpc":"2.0","id":2,"result":{}}"#),
            Err(PublishError::Protocol(_))
        ));
    }

    /// An `isError` on tools/list is still an error — the tools/list path must not have its own,
    /// laxer notion of success than tools/call does.
    #[test]
    fn a_tools_list_that_failed_does_not_decode_as_an_empty_tool_set() {
        let body = r#"{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"error\":\"Unauthorized\",\"status\":401}"}],"isError":true}}"#;
        // Asserting `is_err()` here was NOT enough, and the message above is why: an unauthorized
        // answer has no `tools` array, so before the isError rule was hoisted this failed as
        // Protocol("may not be an MCP server") — a pass, under a test whose own words say the
        // point is to say 'bad token'. The class is the assertion.
        match decode_tools_list(body) {
            Err(PublishError::Credential(_)) => {}
            other => panic!(
                "an unauthorized tools/list must say 'bad token', not send the user to re-check a \
                 URL that is fine. Got {other:?}"
            ),
        }
    }

    /// `initialize` is documented as the cheapest call that proves the URL, the token and the
    /// protocol all work together — so it is the ONE call whose whole job is to detect a bad
    /// credential. Before the `isError` rule was hoisted into the envelope decoder it reported a
    /// rejected token as a working destination: the module's own trap, at the one site that exists
    /// to catch it.
    #[test]
    fn a_rejected_credential_at_initialize_is_not_a_working_destination() {
        match decode_rpc_envelope(CAPTURED_401) {
            Err(PublishError::Credential(_)) => {}
            other => panic!("initialize reported a rejected token as usable: {other:?}"),
        }
    }

    /// The rule has ONE definition and it lives at the funnel, so it must hold on every path — not
    /// just the two that have their own test above. Checking each entry point separately is the
    /// point: covering one and calling the rule verified is how the other two got missed.
    #[test]
    fn the_is_error_rule_holds_on_all_three_entry_points() {
        assert!(decode_rpc_envelope(CAPTURED_401).is_err(), "initialize");
        assert!(decode_tools_list(CAPTURED_401).is_err(), "tools/list");
        assert!(decode_tool_result(CAPTURED_401).is_err(), "tools/call");
    }

    /// `"error": null` alongside a valid result is a common non-conformant spelling. `get("error")`
    /// answers `Some(Value::Null)` for it, so the naive presence check turns a SUCCESSFUL publish
    /// into a protocol error — a false alarm on the happy path, which is the expensive direction.
    #[test]
    fn a_null_error_member_beside_a_real_result_is_still_a_success() {
        let body = r#"{"jsonrpc":"2.0","id":1,"error":null,"result":{"content":[{"type":"text","text":"ok"}]}}"#;
        assert_eq!(decode_tool_result(body).as_deref(), Ok("ok"));
    }

    /// The mirror case, and it fails in the dangerous direction: `{"result":null}` decoded as
    /// `Ok("")` — a successful publish with an empty answer, from a server that said nothing.
    #[test]
    fn a_null_result_is_not_a_successful_publish_with_an_empty_answer() {
        assert!(matches!(
            decode_tool_result(r#"{"jsonrpc":"2.0","id":1,"result":null}"#),
            Err(PublishError::Protocol(_))
        ));
    }

    /// An SSE stream carries notifications AHEAD of the answer. Taking the first JSON-looking
    /// `data:` line hands a progress notification to the envelope decoder, which then reports a
    /// perfectly healthy publish as "not speaking JSON-RPC 2.0".
    #[test]
    fn a_notification_ahead_of_the_answer_does_not_displace_it() {
        let framed = concat!(
            "event: message\n",
            r#"data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}"#,
            "\n\nevent: message\n",
            r#"data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"live"}]}}"#,
            "\n\n",
        );
        assert_eq!(
            decode_tool_result(framed).as_deref(),
            Ok("live"),
            "the notification was decoded instead of the answer"
        );
    }

    // ── The request path ──────────────────────────────────────────────────────────────────────

    /// Both values, or every call fails `-32000 Not Acceptable`. Verified against the live server;
    /// it is not in the MCP spec's prose as a hard requirement, so it reads as optional and is not.
    #[test]
    fn the_mandatory_accept_header_carries_both_values() {
        let h = headers("sk-abc");
        let accept = h
            .iter()
            .find(|(n, _)| *n == "Accept")
            .map(|(_, v)| v.as_str())
            .expect("Accept must be sent");
        assert!(accept.contains("application/json"), "{accept}");
        assert!(accept.contains("text/event-stream"), "{accept}");
    }

    /// The token has exactly one home. This is what makes "the bearer never leaks into a URL, a
    /// request body, or a log line" a property of the code's shape rather than of vigilance.
    #[test]
    fn the_bearer_rides_in_exactly_one_header_and_never_in_the_request_body() {
        const TOKEN: &str = "sk-secret-value";
        let carrying: Vec<_> = headers(TOKEN)
            .into_iter()
            .filter(|(_, v)| v.contains(TOKEN))
            .collect();
        assert_eq!(carrying.len(), 1, "token appears in {carrying:?}");
        assert_eq!(carrying[0].0, "Authorization");
        assert_eq!(carrying[0].1, format!("Bearer {TOKEN}"));

        let body = rpc_request_body(3, "tools/call", json!({ "name": "publish_content" }));
        assert!(!body.contains(TOKEN), "the token reached the body: {body}");
        assert!(!body.contains("Bearer"), "{body}");
    }

    #[test]
    fn the_request_body_is_jsonrpc_2_0_with_the_method_and_params() {
        let body = rpc_request_body(7, "tools/list", json!({ "cursor": "abc" }));
        let v: Value = serde_json::from_str(&body).expect("valid JSON");
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 7);
        assert_eq!(v["method"], "tools/list");
        assert_eq!(v["params"]["cursor"], "abc");
    }

    /// Clause 2 of the redirect rule, and it is NOT implied by clause 1. This tree pins
    /// `ureq 2.12.1`, where `redirects(0)` returns the redirect response as `Ok` rather than
    /// erroring — so without this the body gets parsed and the real cause is hidden behind a
    /// confusing protocol error.
    #[test]
    fn every_3xx_is_refused_and_the_message_names_the_status() {
        for status in [301u16, 302, 303, 307, 308] {
            match refuse_redirect(status) {
                // Configuration, NOT Transport: Transport is the class a caller retries, and a
                // redirect will answer the same way forever. The fix is the URL.
                Err(PublishError::Configuration(m)) => {
                    assert!(m.contains(&status.to_string()), "{m}");
                    assert!(m.contains("redirect"), "{m}");
                }
                other => panic!("{status} was not refused: {other:?}"),
            }
        }
    }

    /// The converse — a real answer must not be mistaken for a redirect. Verified: both the bare
    /// and trailing-slash forms of the endpoint answer 200 with no redirect.
    #[test]
    fn a_2xx_is_not_treated_as_a_redirect() {
        assert!(refuse_redirect(200).is_ok());
        assert!(refuse_redirect(204).is_ok());
        assert!(refuse_redirect(400).is_ok(), "4xx is ureq's business, not this check's");
    }

    /// The three statuses the live endpoint was verified to produce, each routed to the action that
    /// can actually fix it. A 401 that reads as `Transport` sends the user to retry forever.
    #[test]
    fn the_verified_http_statuses_route_to_the_action_that_fixes_them() {
        assert!(matches!(
            classify_http_status(401, ""),
            PublishError::Credential(_)
        ));
        assert!(matches!(
            classify_http_status(404, ""),
            PublishError::Credential(_)
        ));
        // A 500 is the only one of these worth retrying, so it must be the only Transport.
        match classify_http_status(503, "") {
            PublishError::Transport(m) => assert!(m.contains("retrying"), "{m}"),
            other => panic!("a 5xx must be retryable, got {other:?}"),
        }
    }

    /// A 406 means Sparkle sent the wrong `Accept` — a bug here, not a user misconfiguration. If it
    /// read as a credential problem the user would rotate a perfectly good token.
    #[test]
    fn a_406_is_named_as_a_sparkle_bug_not_a_configuration_problem() {
        match classify_http_status(406, "Not Acceptable") {
            PublishError::Protocol(m) => assert!(m.contains("Sparkle bug"), "{m}"),
            other => panic!("expected Protocol, got {other:?}"),
        }
    }

    /// An HTML error page would otherwise put a whole document into a toast.
    #[test]
    fn an_enormous_error_body_is_bounded_before_it_reaches_the_user() {
        let huge = "x".repeat(50_000);
        let m = classify_http_status(500, &huge).message().to_string();
        assert!(m.len() < 400, "message was {} chars", m.len());
    }

    // ── The production call site, through the seam ────────────────────────────────────────────
    // These drive post_json_with — the function production actually runs — rather than the pure
    // helpers in isolation. Before the seam existed, deleting `refuse_redirect(...)` from the call
    // site left the whole suite green, because the only test of it called the helper directly.

    /// Records the request AS BUILT — the URL and headers the transport is handed, not what the
    /// header helper happens to return. That distinction is the whole reason the seam sits below
    /// the header loop rather than above it.
    type SendLog = std::cell::RefCell<Vec<(String, Vec<(String, String)>, String)>>;

    fn recording_sender<'a>(
        status: u16,
        body: &'static str,
        log: &'a SendLog,
    ) -> impl Fn(ureq::Request, &str) -> SendResult + 'a {
        move |req, sent| {
            // EVERY header, via header_names() — not a hand-maintained allow-list. An allow-list
            // is structurally blind twice over: a token copied into some other header is invisible
            // to the leak assertion below, so the check would be narrower than the property it
            // claims; and a fourth mandatory header added to `headers()` would go unobserved until
            // someone remembered to edit a constant in the test module.
            let hdrs: Vec<(String, String)> = req
                .header_names()
                .into_iter()
                .filter_map(|n| req.header(&n).map(|v| (n.clone(), v.to_string())))
                .collect();
            log.borrow_mut()
                .push((req.url().to_string(), hdrs, sent.to_string()));
            Ok((status, Ok(body.to_string())))
        }
    }

    /// The whole point of refusing before reading: the body of a redirect is never parsed. The fake
    /// answers 3xx with a body that is NOT valid JSON, so if the call site ever stopped refusing
    /// first, this would surface as a JSON parse error rather than a redirect refusal.
    #[test]
    fn the_call_site_refuses_a_redirect_before_it_looks_at_the_body() {
        let log = SendLog::default();
        let send = recording_sender(302, "<html>moved</html>", &log);
        let url = endpoint("https://drodio.com/api/mcp").unwrap();
        match post_json_with(&send, &url, "sk-t", "{}") {
            Err(PublishError::Configuration(m)) => assert!(m.contains("302"), "{m}"),
            other => panic!("the redirect reached the parser: {other:?}"),
        }
    }

    /// Not "headers() returns them" — that they are ON THE REQUEST the transport is handed. The
    /// mandatory `Accept` is this module's first documented rule: omit either value and EVERY call
    /// fails `-32000 Not Acceptable`, so "the helper returns it" is not the property worth pinning.
    #[test]
    fn every_mandatory_header_is_on_the_request_that_goes_out() {
        let log = SendLog::default();
        let send = recording_sender(200, r#"{"jsonrpc":"2.0","id":1,"result":{}}"#, &log);
        let url = endpoint("https://drodio.com/api/mcp").unwrap();
        post_json_with(&send, &url, "sk-t", "{\"a\":1}").expect("must succeed");

        let calls = log.borrow();
        assert_eq!(calls.len(), 1, "exactly one request");
        let (sent_url, hdrs, sent_body) = &calls[0];
        assert_eq!(sent_url, "https://drodio.com/api/mcp", "the URL is sent as configured");
        assert_eq!(sent_body, "{\"a\":1}", "the body is sent unaltered");

        // Case-INSENSITIVE, because `header_names()` reports what the request actually holds and
        // ureq normalises to lowercase. HTTP header names are case-insensitive by spec, so pinning
        // the capitalisation would be pinning an implementation detail rather than the property.
        // (The allow-list this replaced hid the difference by only ever asking for its own spelling.)
        let get = |n: &str| {
            hdrs.iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(n))
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| panic!("{n} never reached the request; observed {hdrs:?}"))
        };
        let accept = get("Accept");
        assert!(accept.contains("application/json"), "{accept}");
        assert!(accept.contains("text/event-stream"), "{accept}");
        assert_eq!(get("Content-Type"), "application/json");
        assert_eq!(get("Authorization"), "Bearer sk-t");
        assert!(!sent_url.contains("sk-t"), "the token leaked into the URL");
        assert!(!sent_body.contains("sk-t"), "the token leaked into the body");

        // The module's stated shape-level property: the bearer has exactly ONE home. Asserted over
        // every header actually on the request, so a token copied into a stray debug header fails
        // here rather than passing an allow-list that never looked.
        let elsewhere: Vec<_> = hdrs
            .iter()
            .filter(|(k, v)| !k.eq_ignore_ascii_case("Authorization") && v.contains("sk-t"))
            .collect();
        assert!(elsewhere.is_empty(), "the token also rode in {elsewhere:?}");
    }

    /// The status routing runs at the call site, not just inside `classify_http_status`.
    #[test]
    fn the_call_site_routes_a_401_and_a_500_to_different_classes() {
        let url = endpoint("https://drodio.com/api/mcp").unwrap();
        let log = SendLog::default();

        let unauthorized = recording_sender(401, "nope", &log);
        assert!(matches!(
            post_json_with(&unauthorized, &url, "sk-t", "{}"),
            Err(PublishError::Credential(_))
        ));

        let broken = recording_sender(503, "down", &log);
        assert!(
            matches!(
                post_json_with(&broken, &url, "sk-t", "{}"),
                Err(PublishError::Transport(_))
            ),
            "a 5xx is the one class worth retrying"
        );
    }

    /// **The regression guard, driving the real production path** — not a fake that supplies the
    /// answer, and not a helper reachable only from code no test runs.
    ///
    /// Two earlier attempts at this guard both missed, one layer apart, and the shape is worth
    /// stating because it kept recurring: the first injected a sender that ALREADY returned the
    /// error, so it asserted only a pass-through; the second tested `normalize_response` while the
    /// call that reaches it lived BELOW the injection seam, so re-applying the original one-line
    /// regression left everything green. The read now crosses the seam unresolved, so this test
    /// pushes an unreadable body through `post_json_with` exactly as production would.
    #[test]
    fn an_unreadable_2xx_body_is_a_retryable_failure_through_the_real_call_site() {
        let url = endpoint("https://drodio.com/api/mcp").unwrap();
        let torn = |_: ureq::Request, _: &str| -> SendResult {
            Ok((200, Err("connection reset mid-read".to_string())))
        };
        match post_json_with(&torn, &url, "sk-t", "{}") {
            Err(PublishError::Transport(m)) => assert!(m.contains("unreadable"), "{m}"),
            other => panic!("an unreadable 2xx was not a retryable failure: {other:?}"),
        }
    }

    /// The asymmetric half, also through the real call site: an error page we could not read is not
    /// itself a failure — the STATUS is the answer, and `classify_http_status` works from it.
    #[test]
    fn an_unreadable_error_page_still_reports_its_status_through_the_real_call_site() {
        let url = endpoint("https://drodio.com/api/mcp").unwrap();
        let torn = |_: ureq::Request, _: &str| -> SendResult {
            Ok((503, Err("truncated".to_string())))
        };
        match post_json_with(&torn, &url, "sk-t", "{}") {
            // 503, not the read failure: it must still be classified from its status.
            Err(PublishError::Transport(m)) => assert!(m.contains("503"), "{m}"),
            other => panic!("expected the status to survive, got {other:?}"),
        }
    }

    /// **The boundary of the hinge, pinned on BOTH sides.** `status < 400` is what separates
    /// "retryable transport failure" from "report the status", and testing only 200 and 503 leaves
    /// it free: `<=` keeps both of those green while turning an unreadable HTTP 400 from an
    /// unretryable client error into a retryable one — the same misclassification this whole change
    /// set exists to prevent, at the other end of the range. Reachable in production, since ureq
    /// delivers a 400 through the `Err(Error::Status(..))` arm.
    #[test]
    fn the_retryable_boundary_sits_exactly_at_400() {
        let torn = || Err("truncated".to_string());
        // 399 and below: unreadable means we learned nothing, so it is retryable.
        assert!(normalize_response(399, torn()).is_err(), "399 must be retryable");
        assert!(normalize_response(200, torn()).is_err(), "200 must be retryable");
        // 400 and above: the status IS the answer, so it survives an unreadable body.
        assert_eq!(normalize_response(400, torn()), Ok((400, String::new())));
        assert_eq!(normalize_response(503, torn()), Ok((503, String::new())));
        // ...and a body that WAS readable is passed through untouched at either end.
        assert_eq!(
            normalize_response(200, Ok("hello".to_string())),
            Ok((200, "hello".to_string()))
        );
    }

    /// The semantic guard that replaced six rounds of source-shape checking on
    /// `send_over_network`. Every fabrication those rounds actually chased — a swallowing arm, a
    /// sibling arm, a conditional inside the arm — reaches the caller as a status-**0** "success",
    /// because a request that never got an answer has no status to copy. Rejecting an out-of-range
    /// status is decidable and driven through the production call site, which a textual check was
    /// neither.
    ///
    /// **Named for what it covers.** A fabrication carrying a plausible status is NOT covered and
    /// is not coverable here — see the note at the check itself.
    #[test]
    fn an_out_of_range_status_is_a_transport_failure() {
        let url = endpoint("https://drodio.com/api/mcp").unwrap();
        for status in [0u16, 1, 99] {
            let fabricated =
                move |_: ureq::Request, _: &str| -> SendResult { Ok((status, Ok(String::new()))) };
            match post_json_with(&fabricated, &url, "sk-t", "{}") {
                Err(PublishError::Transport(m)) => {
                    assert!(m.contains("did not deliver a final answer"), "{m}");
                    // The message must NAME the status — and the assertion is on the FORMATTED
                    // phrase, not the bare numeral. A substring test for a one- or two-character
                    // number is vacuous here: the static text contains "Below 200" and "interim
                    // 1xx", so `contains("0")` and `contains("1")` hold no matter what the format
                    // string interpolates. Deleting the interpolation entirely left two of these
                    // three cases green.
                    assert!(
                        m.contains(&format!("HTTP status {status}")),
                        "message omits the status it is describing: {m}"
                    );
                }
                other => panic!("a fabricated status-{status} answer decoded as {other:?}"),
            }
        }
    }

    /// The boundary sits at **200**, not 100, and the difference is a correctness claim rather
    /// than an off-by-one. A 1xx is INTERIM (RFC 9110 §15.2): not a final response, a final status
    /// still follows, and its body is not the answer — so accepting one hands the caller a
    /// non-answer that surfaces downstream as an unretryable protocol fault, the exact class this
    /// check exists to close.
    ///
    /// **An earlier revision drew the floor at 100 and this test asserted `== Ok("{}")` for a 100**
    /// — positively pinning "a 1xx is a success whose body reaches the caller" as though it were
    /// the intended contract. That is the cost of getting a floor wrong: the test does not merely
    /// fail to catch the defect, it certifies it. The floor's own rationale lives at the check in
    /// `post_json_with`, which records this history from the source side; it is here too because
    /// only this side names the ASSERTION that did the certifying. The separate question of why
    /// the fixture's BINDING is named `final_answer` is answered once, at the binding itself.
    ///
    /// Both sides are asserted, because a floor is only pinned by the pair — and the 200 case
    /// here is also the floor's CONVERSE, which is why no separate "a real status still works"
    /// test exists. One did, and was deleted: three rounds running, its doc claimed a unique role
    /// (first "stops reject-everything", then "only place the call count is pinned") and both were
    /// already owned elsewhere — the first by the `assert_eq!` below, which pins the returned body
    /// rather than `is_ok()`, the second by `every_mandatory_header_is_on_the_request_that_goes_out`,
    /// which asserts `calls.len() == 1` on the same fixture. A test whose justification has to be
    /// reinvented each time it is questioned is a test with no job.
    #[test]
    fn the_final_answer_boundary_sits_at_200() {
        let url = endpoint("https://drodio.com/api/mcp").unwrap();
        // 1xx and 199: interim or impossible — neither is an answer.
        for status in [100u16, 199] {
            let interim =
                move |_: ureq::Request, _: &str| -> SendResult { Ok((status, Ok(String::new()))) };
            match post_json_with(&interim, &url, "sk-t", "{}") {
                Err(PublishError::Transport(m)) => {
                    assert!(m.contains("did not deliver a final answer"), "{m}");
                    // A 1xx IS a valid status, so the copy must not call it invalid — it must say
                    // it is not FINAL. Keyed on the ROOT WORD, not a phrase: the copy this guard
                    // exists to prevent read "no valid HTTP status", and an earlier version of
                    // this very assertion looked for "not a valid" — which that phrase does not
                    // contain, so restoring the exact regression left it green. "invalid",
                    // "not valid", "no valid" and "isn't valid" all contain `valid`; enumerating
                    // the phrasings is the open set, forbidding the root word is the closed one.
                    // (Same lesson as the whitelist that replaced the denylist in the source
                    // guard above, arrived at twice in one file.)
                    assert!(
                        !m.to_lowercase().contains("valid"),
                        "1xx is a VALID status that is merely not final; copy calling it invalid \
                         misdescribes the destination to the user: {m}"
                    );
                    assert!(m.contains("interim"), "the copy should name what 1xx is: {m}");
                    // Same formatted-phrase check as above, but NOT for the same reason. Unlike
                    // `0`/`1` there, "100" and "199" do not occur in the static text, so a bare
                    // numeral would work TODAY.
                    //
                    // It is keyed to the phrase anyway because that non-vacuity is an accident of
                    // the current wording, not a property of the check: the message already
                    // carries "200" and "1xx", and copy that grows one more number — a retry
                    // count, an RFC reference, a second status — silently turns a bare numeral
                    // into the vacuous form the sibling already suffers. The phrase is stable
                    // under that; the numeral's grip depends on prose nobody will re-audit.
                    assert!(
                        m.contains(&format!("HTTP status {status}")),
                        "message omits the status it is describing: {m}"
                    );
                }
                other => panic!("status {status} is not a final answer, got {other:?}"),
            }
        }
        // Named `final_answer`, not `informational`. This fixture has always been the ACCEPTED
        // side; it held a 100 back when the floor did, where `informational` was a fair name for a
        // 1xx, and became a 200 when the floor moved. So what flipped is the VALUE, not the side —
        // and the name followed neither. (Why the floor was wrong at 100 is in the doc above; this
        // note owns only the naming.) The doc points readers here as the sole home of the floor's
        // converse, so a binding calling a final answer "informational" is the wrong thing for
        // them to land on.
        let final_answer =
            |_: ureq::Request, _: &str| -> SendResult { Ok((200, Ok("{}".to_string()))) };
        // Asserts what the call DID, not the absence of one error string. The previous form
        // (`!matches!(…, Err(Transport(m)) if m.contains("did not answer"))`) is satisfied by any
        // other failure — a different Transport message, a Protocol error, anything — so it proved
        // nothing about the fixture's status being ACCEPTED, only that one message did not appear.
        // Phrased as the PROPERTY rather than a status number, so it cannot go stale under a
        // future floor change — see the `final_answer` note above, which owns the naming history.
        // Absence is not evidence; this repo's #1 finding.
        assert_eq!(
            post_json_with(&final_answer, &url, "sk-t", "{}").as_deref(),
            Ok("{}"),
            "200 is the first FINAL status: its body must come back untouched, not merely fail \
             differently"
        );
    }


    /// A dead host — nothing answered at all — is distinct from an answer we could not read, and
    /// both are `Transport`. This one covers the sender's own `Err` channel; the three tests above
    /// cover the read.
    ///
    /// **The fixture uses the message that channel actually emits.** A previous revision fed in
    /// `"the destination's answer was unreadable: …"` and then asserted that substring — but that
    /// wording belongs exclusively to `normalize_response` and can never arrive through the
    /// sender's `Err`, so the test asserted the input it had supplied itself and left a false
    /// impression that the dead-host shape was covered.
    #[test]
    fn a_transport_failure_stays_a_transport_failure_through_the_call_site() {
        let url = endpoint("https://drodio.com/api/mcp").unwrap();
        let dead = |_: ureq::Request, _: &str| -> SendResult {
            Err("could not reach the destination: dns error: no record found".to_string())
        };
        match post_json_with(&dead, &url, "sk-t", "{}") {
            Err(PublishError::Transport(m)) => assert!(m.contains("could not reach"), "{m}"),
            other => panic!("a dead host must stay retryable, got {other:?}"),
        }
    }

    /// **A SOURCE-LEVEL guard, and it earns its place only because the stronger kind is
    /// unavailable.** `send_over_network` needs a real socket, so no behavioural test reaches it:
    /// every test above injects its own sender. That means re-applying the original regression on
    /// its one read line leaves all of them green, which is exactly how that reversion slipped
    /// through once already.
    ///
    /// This pins TEXT rather than behaviour, which is weaker and should stay rare. Two properties
    /// keep it from being weaker than it looks — both learned from a review of the first attempt,
    /// which was a whole-file absence check on ONE 32-character spelling:
    ///
    /// - **It pins the CLOSED FORM of the read expression, not a prefix of it.** An absence check
    ///   is defeated by any paraphrase — `unwrap_or_else(|_| String::new())`,
    ///   `unwrap_or(String::new())`, `.ok().unwrap_or_default()` all reproduce the historical
    ///   behaviour exactly. But a *prefix* presence check is defeated too, and that is the subtler
    ///   trap: asserting `into_string().map_err` only constrains the HEAD of the expression, while
    ///   the swallowing happens in the TAIL — `…map_err(|e| e.to_string()).or(Ok(String::new()))`
    ///   keeps every asserted character, adds no banned token, compiles unchanged, and reintroduces
    ///   the bug. So the assertion is the whole expression AND its POSITION — it must be the
    ///   function's tail. Presence alone is not enough either: `contains` is satisfied verbatim by
    ///   a two-line reversion that binds the correct read to a local and swallows the `Err` on the
    ///   next line. `ends_with` closes that whole class in one token. The denylist below is a
    ///   **backstop**, not the primary defence: enumerating an open set of spellings is exactly
    ///   what failed on every previous attempt at this guard.
    ///
    /// **THE LIMIT OF THIS GUARD, and why iteration on it stops here.** It is a textual check over
    /// Rust source, so it cannot be complete: a sufficiently determined edit can always express the
    /// same defect in a form no string check anticipates. Six review rounds went into it, each
    /// defeating the previous version with a more contrived construction — a paraphrase, a
    /// relocation, a tail wrapper, a two-line rebind, a sibling arm, a bound local. What it now
    /// pins are INVARIANTS rather than spellings, which is the most a textual check can do:
    /// the read's closed form, its position as the function's result, exactly one success tuple,
    /// and — as a WHITELIST rather than a denylist — that every early `return` is a `return Err(`,
    /// scanned on a word boundary **on both sides**, with any separator trimmed. Both halves of
    /// that were learned the same way: a newline between keyword and operand made one version
    /// visit nothing, and requiring whitespace on the right made the next version skip
    /// `return(expr)` — which is valid Rust, since `return` is a keyword rather than a call.
    /// That last one is the shape that finally holds: banning success spellings is an open set
    /// (`Ok(`, then `Ok(local)`, then `Result::Ok(…)`, forever), while the legal early exits are a
    /// closed set of exactly one, so requiring that needs no knowledge of what a success looks
    /// like.
    ///
    /// **Fourteen review rounds went into this one test**, each defeating the previous version with
    /// a construction the previous version's author had not imagined: a paraphrase, a relocation,
    /// a tail wrapper, a two-line rebind, a sibling arm, a path-qualified constructor, a whitespace
    /// variant, a comment, a string literal, a line continuation, a second match arm. That is what
    /// a textual check over a Turing-complete language costs, and it is the strongest available
    /// argument for the note below rather than against it.
    ///
    /// Treat it as a **speed bump for the accidental reversion it was written for — which happened
    /// twice — and not as proof.** The real assurance is that every DECISION lives above this
    /// function, where behavioural tests reach it; what is left here is plumbing. If this guard
    /// ever obstructs legitimate work, the right response is to make the boundary injectable, not
    /// to add a seventh spelling to it.
    ///
    /// **What it costs, stated rather than glossed: it reds on CORRECT restructuring too.**
    /// Binding the read to a local and returning it — behaviourally identical — fails this test,
    /// because the guard pins one exact form and its position rather than a behaviour. That is a
    /// deliberate trade, not an oversight: this is a line whose silent reversion shipped a real
    /// defect, at a boundary no behavioural test can reach, and every looser version of this guard
    /// was defeated within one review round. The message names the required form, so a legitimate
    /// restructure is a short fix — and the point of the friction is that it forces whoever
    /// restructures to come back here and re-establish that the `Err` still reaches
    /// `normalize_response`.
    /// - **It is SCOPED to the function, and fails loudly if that function moves.** A file-wide
    ///   absence assertion goes vacuous the moment its subject is renamed or relocated: the needle
    ///   count is still zero, so the test passes while guarding nothing. The `expect` below turns
    ///   that case into a failure. Scoping also removes the self-reference problem — this test's
    ///   own source sits outside the slice being searched.
    #[test]
    fn the_transport_never_swallows_an_unreadable_body() {
        const TAIL: &str = concat!(
            "Ok((status, resp.into_string()",
            ".map_err(|e| e.to_string())))"
        );

        let src = include_str!("publish_client.rs");
        // Bounded at the function's own closing brace, NOT at the next `fn` — the doc comment on
        // the function after it recounts this regression and quotes the spelling being banned, so
        // a looser bound makes the guard fail on its own explanation.
        let body = src
            .split_once("fn send_over_network(")
            .and_then(|(_, rest)| rest.split_once("\n}\n"))
            .map(|(b, _)| b)
            .expect("send_over_network moved or was renamed — this guard now covers nothing");

        // ── One CODE view, used by every assertion below ──────────────────────────────────────
        // Comments and string CONTENTS are both prose, and both contain the words this guard
        // matches on. Every assertion reads this, never `body`: mixing the two is what produced
        // the last two rounds of findings — one assertion satisfiable by a comment quoting the
        // right text, another red-able by a comment mentioning it.
        //
        // Drops string bodies rather than only truncating at `//`, because a naive
        // `split_once("//")` truncates inside a literal too — `contains("://") { return Ok(z); }`
        // would hide its own early return — and because `return` is an ordinary English word that
        // this function's one literal (a user-facing error message) could easily contain.
        //
        // NOT handled, stated rather than implied: raw strings, char literals, block comments.
        // Block comments are left deliberately — stripping them would hide `return/*c*/Ok(z)`.
        // Folded over the WHOLE body, with `in_string` threaded across newlines. A per-line
        // version resets the flag at every newline, so a backslash-continued literal inverts the
        // parity for the rest of the following line — emitting that line's PROSE as code (a
        // false-positive red at someone who reworded a message) and silently dropping the real
        // code after the closing quote (the same silent class as the `//`-inside-a-literal leak).
        // This file already uses `\` continuations for long messages, so it is a shape a
        // maintainer reaches for by habit.
        //
        // NOT handled, stated rather than implied: raw strings (`r"…"`), char literals, and block
        // comments. Block comments are left deliberately — stripping them would hide
        // `return/*c*/Ok(z)`.
        fn code_view(src: &str) -> String {
            let mut out = String::with_capacity(src.len());
            let mut chars = src.chars().peekable();
            let (mut in_string, mut in_line_comment) = (false, false);
            while let Some(c) = chars.next() {
                match c {
                    '\n' => {
                        in_line_comment = false;
                        out.push('\n');
                    }
                    _ if in_line_comment => {}
                    // An escape consumes the next char. When that char is a newline (a line
                    // continuation) the newline is still emitted, so line structure survives.
                    '\\' if in_string => {
                        if chars.peek() == Some(&'\n') {
                            chars.next();
                            out.push('\n');
                        } else {
                            chars.next();
                        }
                    }
                    '"' => {
                        in_string = !in_string;
                        out.push('"');
                    }
                    '/' if !in_string && chars.peek() == Some(&'/') => in_line_comment = true,
                    _ if in_string => {}
                    _ => out.push(c),
                }
            }
            out
        }
        let code = code_view(body);

        // ── 1. The read's closed form, AT THE TAIL ────────────────────────────────────────────
        // `ends_with`, not `contains`: position, not mere presence. `contains` is satisfied
        // verbatim by binding the correct read to a local and swallowing the Err on the next line.
        assert!(
            code.trim_end().ends_with(TAIL),
            "the response read must hand its failure to normalize_response UNALTERED, as the \
             function's final expression — no `.or`, no default, no wrapper, nothing after it. \
             normalize_response is what decides an unreadable 2xx is RETRYABLE; anything that \
             swallows the Err here makes it an empty success that surfaces downstream as an \
             unretryable protocol fault."
        );

        // ── 2. Exactly ONE success exit, and it is that tail ──────────────────────────────────
        // A WHITELIST, which is the whole difference between this and every earlier version.
        // Banning success spellings is an open set — `Ok(`, `Ok(local)`, `Result::Ok(…)`, forever.
        // The legal early exits are a closed set of exactly one, so require THAT: any success
        // form fails by construction, path-qualified or not, without this test knowing its name.
        //
        // Word boundary on BOTH sides. Left alone is not enough: making the right side a
        // whitespace *requirement* skips `return(expr)` and `return/*c*/expr`, both valid Rust
        // since `return` is a keyword token rather than a call.
        let is_word_char = |c: char| c.is_alphanumeric() || c == '_';
        for (at, _) in code.match_indices("return") {
            let after = &code[at + "return".len()..];
            if code[..at].chars().next_back().is_some_and(is_word_char)
                || after.starts_with(is_word_char)
            {
                continue; // inside `returned`, `returns`, `_return`
            }
            let rest = after.trim_start();
            assert!(
                rest.starts_with("Err("),
                "send_over_network has exactly ONE success exit and it is the function's tail; \
                 every early return must be a failure. Found `return {}`, which manufactures a \
                 success from a failure — the same defect as swallowing the read, reaching the \
                 user identically: a retryable transport failure reported as an unretryable \
                 protocol fault.",
                rest.chars().take(24).collect::<String>()
            );
        }

        // ── 3. What used to be here, and why it is gone ───────────────────────────────────────
        // Six review rounds tried to prove textually that the transport arm EXITS rather than
        // fabricating a response for the shared tail. Each version fell to a construction its
        // author had not imagined — a sibling arm, a path-qualified constructor, a block-less arm,
        // an unanchored slice — and two of them red at correct code instead. The reason is
        // structural: "every path through this arm diverges" is a CONTROL-FLOW property, and
        // string matching cannot decide it. A `contains` proves an exit exists on SOME path, never
        // on every path.
        //
        // The reachable part of that class is now handled one layer down instead, semantically:
        // `post_json_with` rejects an out-of-range status, because no HTTP answer is below 100.
        // Every fabrication those rounds actually chased reaches the caller as a status-0
        // "success" — a request that never got an answer has no status to copy — so rejecting it
        // there is decidable and driven through the production call site by
        // `an_out_of_range_status_is_a_transport_failure`.
        //
        // **NOT closure, and the difference matters to whoever reads this next.** A fabrication
        // carrying a plausible status (`(200, Ok(""))`) is indistinguishable at that layer from a
        // real empty 200, so it remains a stated known limit rather than a gap to harden. The
        // backstop below is a smell detector for the one route that has appeared, not a proof.
        //
        // The lesson, recorded because it cost far more than the fix: when a guard keeps falling
        // to new constructions, the guard is usually asking an undecidable question. Move the
        // invariant to where the wrong answer becomes harmless rather than hardening the check.

        // A BACKSTOP, explicitly not closure. The remaining gap above — a fabrication carrying a
        // plausible status — is undecidable one layer down, so nothing here can prove it away.
        // What this catches is the single route that has ever appeared in practice: the transport
        // synthesizing a response. The real function never constructs one, so it cannot false-
        // positive; and it is narrow by construction, since parsing a response from a string is a
        // second route it does not see. Labelled as a smell detector so nobody reads it as proof.
        assert!(
            !code.contains("Response::new"),
            "send_over_network must never CONSTRUCT a response — a synthesized answer is a \
             failure wearing a success's clothes. Report the failure instead. (Backstop only: a \
             fabrication carrying a plausible status is not detectable here at all.)"
        );

        // ── 4. Backstops on the same invariant, one layer coarser ─────────────────────────────
        assert_eq!(
            code.matches(concat!("Ok", "((")).count(),
            1,
            "exactly one success tuple is constructed; assertion 1 pins where"
        );
        // The read line specifically must not default or discard. `.next_back()`, not `.find()`:
        // an earlier line mentioning the read would otherwise capture the window.
        let read_line = code
            .lines()
            .filter(|l| l.contains("into_string()"))
            .next_back()
            .expect("the response read moved — this guard now covers nothing");
        for defaulting in ["unwrap_or", ".ok()", "expect(", ".or(", ".or_else(", "match "] {
            assert!(
                !read_line.contains(defaulting),
                "`{defaulting}` on the response read defaults or discards the failure — the exact \
                 regression this guard exists for. Line: {read_line}"
            );
        }
    }

    // ── Re-validation at call time ────────────────────────────────────────────────────────────

    /// `config.toml` is a text file on disk, so a hand edit routes around every check the configure
    /// pane made. This is the last gate before the token goes on the wire.
    #[test]
    fn a_hand_edited_url_is_re_validated_at_call_time() {
        for bad in [
            "http://drodio.com/api/mcp",
            "https://user:pw@drodio.com/api/mcp",
            "file://localhost/etc/passwd",
            "",
        ] {
            assert!(
                endpoint(bad).is_err(),
                "{bad:?} reached the network path with a bearer token attached"
            );
        }
    }

    /// A URL that will never work is NOT a transport failure. The distinction is load-bearing at
    /// exactly one moment: the caller decides whether to retry, and a caller that retries
    /// `http://drodio.com/api/mcp` retries it forever. `Transport` is reserved for the things a
    /// retry can actually fix — DNS, connect, timeout, 5xx.
    #[test]
    fn a_url_that_can_never_work_is_a_configuration_failure_not_a_retryable_one() {
        for bad in ["http://drodio.com/api/mcp", "https://u:p@drodio.com/api/mcp", "nonsense"] {
            match endpoint(bad) {
                Err(PublishError::Configuration(_)) => {}
                other => panic!("{bad:?} must not be retryable, got {other:?}"),
            }
        }
    }

    /// The converse, and the loopback exemption that lets a destination be developed locally.
    #[test]
    fn the_real_destination_and_a_local_dev_server_both_pass_call_time_validation() {
        assert!(endpoint("https://drodio.com/api/mcp").is_ok());
        assert!(endpoint("http://localhost:3000/api/mcp").is_ok());
    }
}
