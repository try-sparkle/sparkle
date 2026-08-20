//! The Tauri IPC boundary, instrumented — our own `ipc:` URI-scheme protocol, shadowing Tauri's.
//!
//! ── WHY A PROTOCOL AND NOT A WRAPPER AROUND EVERY COMMAND ─────────────────────────────────────
//! `cmd_timing::measure` (still live, still useful) wraps `invoke_handler`, so for a SYNC command it
//! measures the real body and for an `async` one it measures only the dispatch hop — the handler
//! runs later, on the async runtime, long after `measure` returned. 232 of this crate's 344 commands
//! are `async`, and the 2.5-second `bd` stall that motivated bead `sparkle-i7ryx` lives in exactly
//! that set. So the one number `cmd_timing` can produce for the commands we care about most is the
//! number that is guaranteed to look fast.
//!
//! Tauri's own `ipc:` protocol handler does have the true finish time: it hands `on_message` a
//! RESPONDER closure, and Tauri calls that closure at command completion for both sync and async
//! (`InvokeResolver::return_result`, tauri-2.11.3 `src/ipc/mod.rs:479-490`). Registering our own
//! `ipc:` protocol substitutes our responder for Tauri's — `src/manager/webview.rs:280` registers
//! Tauri's only `if !registered_scheme_protocols.contains(&"ipc".into())`, and the builder's
//! protocols are pushed into that list at `:230`, before the check. There is no reserved-scheme
//! guard. That buys true handler-finish timing for all 344 commands with ZERO command changes.
//!
//! ── THE PRICE, AND HOW IT IS PAID ─────────────────────────────────────────────────────────────
//! This handler BECOMES the app's IPC path. A bug here is not a bad measurement, it is every invoke
//! in the app failing — and the worst failure available is a HUNG PROMISE, because a renderer whose
//! `invoke()` never settles has no timeout and no error to show. So:
//!
//!   * every error path responds, with the same 500 + `text/plain` body Tauri uses
//!     (`src/ipc/protocol.rs:143-161`), so a bug in our parser degrades to Tauri's own failure mode;
//!   * nothing here unwraps, panics, or indexes without a bound — `plain_500` is built with header
//!     constants and no builder `.unwrap()` precisely so it cannot itself become the hang;
//!   * `parse_invoke_request` is a faithful local copy of Tauri's, and `SOURCE GUARDS` below fail
//!     the build if the thing it was copied from moves.
//!
//! ── WHAT IS RE-IMPLEMENTED, AND WHY THAT IS ONLY ~50 LINES ────────────────────────────────────
//! Tauri's `parse_invoke_request` takes the `AppManager` for exactly one reason: the `isolation`
//! pattern, whose body is behind `#[cfg(feature = "isolation")]`. This app does not enable that
//! feature and declares no `pattern` in `tauri.conf.json`, so the manager argument is dead for us
//! and the function reduces to header extraction plus a content-type switch. The `tracing` feature
//! is likewise off, which is load-bearing: with it on, upstream runs a `serde_json::to_string` of
//! the whole request body on every invoke (`src/ipc/protocol.rs:70`). Both facts are asserted by the
//! source guards, so a `tauri` bump that changes either FAILS THE BUILD rather than silently
//! diverging from the code this was copied from.
//!
//! ── THE RECORD PATH TAKES NO LOCK, ALLOCATES NOTHING, AND LOGS NOTHING ────────────────────────
//! See `ipc_ring`'s header. Per-row `tracing` would pay `support::redact_secrets` (7 regex passes)
//! twice through both sinks on the very thread we are trying to unblock (bead `sparkle-zllfb`), so
//! formatting happens ONLY at dump time and a dump emits exactly ONE event.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS,
    CONTENT_TYPE,
};
use tauri::http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode};
use tauri::ipc::{CallbackFn, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder, Url};

use crate::ipc_ring::{self, Record};

// ── Header names, spelled exactly as tauri spells them (`src/ipc/protocol.rs:24-30`) ────────────
const TAURI_CALLBACK_HEADER_NAME: &str = "Tauri-Callback";
const TAURI_ERROR_HEADER_NAME: &str = "Tauri-Error";
const TAURI_INVOKE_KEY_HEADER_NAME: &str = "Tauri-Invoke-Key";
const TAURI_RESPONSE_HEADER_NAME: &str = "Tauri-Response";
const TAURI_RESPONSE_HEADER_ERROR: &str = "error";
const TAURI_RESPONSE_HEADER_OK: &str = "ok";

/// Ours. The renderer's correlation id, `<epoch>.<seq>`. Lower-case because `scripts/ipc-protocol.js`
/// merges it into the `invoke()` headers bag and HTTP header names are case-insensitive anyway.
const SPARKLE_IPC_HEADER_NAME: &str = "x-";

/// The dump document's schema tag. Bump it when a reader would have to change.
const DUMP_SCHEMA: &str = "sparkle.ipc.timeline/2";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The protocol handler
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// The registered `ipc:` handler. A three-line adapter over [`handle_ipc`] because
/// `UriSchemeContext` and `UriSchemeResponder` both have private constructors and so cannot be built
/// in a test — the seam is here rather than deeper so that everything below it IS the production
/// code path, driven by the tests exactly as the app drives it.
pub fn ipc_protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    handle_ipc(ctx.app_handle(), ctx.webview_label(), request, move |response| {
        responder.respond(response)
    });
}

/// A `text/plain` 500 carrying `msg`, byte-identical in shape to what Tauri answers with
/// (`src/ipc/protocol.rs:143-161`).
///
/// Built field by field rather than through `Response::builder().….unwrap()` so there is no panic
/// available on the one path whose whole job is to keep a failure from becoming a hung promise.
fn plain_500(msg: &str) -> Response<Cow<'static, [u8]>> {
    let mut r = Response::new(Cow::Owned(msg.as_bytes().to_vec()));
    *r.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
    r
}

/// The renderer's correlation id for this request, or 0 when it sent none or sent nonsense.
///
/// The wire format is `<epoch>.<seq>` — a page-load epoch plus a monotonically increasing sequence
/// number, because a reload restarts `seq` at 0 and `seq` alone would then collide across reloads.
/// The two are packed into one `u64` as `(epoch as u32) << 32 | (seq as u32)`. Truncating the epoch
/// to its low 32 bits is lossy for display but NOT for the join: the renderer computes the same
/// packing over the values it sent, so a row matches or it does not.
fn correlation_id(headers: &HeaderMap) -> u64 {
    let Some(raw) = headers.get(SPARKLE_IPC_HEADER_NAME).and_then(|v| v.to_str().ok()) else {
        return 0;
    };
    let Some((epoch, seq)) = raw.split_once('.') else { return 0 };
    let (Ok(epoch), Ok(seq)) = (epoch.parse::<u64>(), seq.parse::<u64>()) else { return 0 };
    ((epoch as u32 as u64) << 32) | (seq as u32 as u64)
}

/// Which argument names the SUBJECT of a request, per command — the allowlist, and the only way an
/// argument value can reach a dump.
///
/// `arg_bytes` records that a request carried 632 bytes; it cannot say WHICH terminal they were
/// bound for. That is the fact both `sparkle-epc1zh` hang captures lacked: a `pty_write` entered at
/// 03:56:23.349 with 632 arg bytes and never completed, and nothing in the process could name the
/// session it was writing to.
///
/// AN ALLOWLIST, never a general "record the args" switch. Command arguments carry prompts, file
/// paths, tokens and user text, and a dump is attached to bug reports. Two independent limits keep
/// this safe: a command must be named here, AND the value must parse as a uuid
/// (`ipc_ring::parse_uuid`) or it is dropped. Adding an entry can therefore leak an identifier at
/// worst, never a secret.
fn subject_arg_for(cmd: &str) -> Option<&'static str> {
    match cmd {
        // The PTY session uuid. Not a secret: it is minted by the app per terminal and already
        // appears in `pty:output` / `pty:exit` events.
        "pty_write" => Some("id"),
        _ => None,
    }
}

/// The value of a top-level JSON string field named `key`, without parsing the document.
///
/// A hand-rolled byte scan rather than `serde_json`, because this runs on the IPC hot path for
/// every `pty_write` — i.e. every keystroke — and a paste can be megabytes. Parsing the payload
/// here would double the parse cost of the very command whose latency this module exists to
/// measure.
///
/// It returns the FIRST `"key":"…"` in the body. A nested occurrence inside another string value
/// could in principle be matched instead; Tauri serialises the parameters in declaration order so
/// in practice the real one comes first, and the uuid filter at the call site means a mismatch
/// yields a wrong identifier at worst — never a leak. Correctness of the value is not a safety
/// property here, only its shape is.
fn json_string_field<'a>(body: &'a [u8], key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\":\"");
    let n = needle.as_bytes();
    let start = body.windows(n.len()).position(|w| w == n)? + n.len();
    let rest = body.get(start..)?;
    let end = rest.iter().position(|&c| c == b'"')?;
    std::str::from_utf8(rest.get(..end)?).ok()
}

/// The subject uuid to record for this request, or `None`.
///
/// `path` is the raw request path (`/pty_write`). Matched undecoded: a command name is
/// `[a-z0-9_]+`, which percent-encoding never alters, so decoding first would allocate on the hot
/// path to reach the same answer.
fn subject_for(path: &str, body: &[u8]) -> Option<u128> {
    let cmd = path.strip_prefix('/')?;
    let arg = subject_arg_for(cmd)?;
    ipc_ring::parse_uuid(json_string_field(body, arg)?)
}

/// The body of the `ipc:` handler, with the responder abstracted so a test can observe it.
///
/// `respond` is `FnOnce`: every path through this function calls it EXACTLY once, which is the
/// property that keeps a renderer promise from hanging. The compiler enforces the "at most once"
/// half; the `a_malformed_request_gets_the_upstream_500_not_a_hang` test enforces the "at least
/// once" half for the paths a test can reach.
pub(crate) fn handle_ipc<R: Runtime, F>(
    app: &AppHandle<R>,
    label: &str,
    request: Request<Vec<u8>>,
    respond: F,
) where
    F: FnOnce(Response<Cow<'static, [u8]>>) + Send + 'static,
{
    // Upstream wraps every response — success, error and OPTIONS alike — in these two CORS headers
    // (`src/ipc/protocol.rs:47-56`). Omitting them on the error paths is the classic way an error
    // becomes a hang instead: the webview rejects the response before it ever reads the status.
    let respond = move |mut response: Response<Cow<'static, [u8]>>| {
        response.headers_mut().insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
        response.headers_mut().insert(
            ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static(TAURI_RESPONSE_HEADER_NAME),
        );
        respond(response);
    };

    match *request.method() {
        Method::POST => {
            // FIRST, before any work of ours: this stamp is what makes our own parse cost separable
            // from the renderer's queue wait and from the backend's handler time.
            let t_entry_ns = ipc_ring::now_ns();
            let corr_id = correlation_id(request.headers());
            if corr_id == 0 {
                ipc_ring::note_unjoined();
            }
            let arg_bytes = request.body().len().min(u32::MAX as usize) as u32;
            // BEFORE `parse_invoke_request`, which consumes the request. Cheap and allowlisted —
            // see `subject_for`.
            let subject = subject_for(request.uri().path(), request.body());

            let Some(win) = app.get_webview_window(label) else {
                respond(plain_500("failed to acquire webview reference"));
                return;
            };

            let req = match parse_invoke_request(request) {
                Ok(req) => req,
                Err(e) => {
                    respond(plain_500(&e));
                    return;
                }
            };

            let ticket = ipc_ring::begin_traced(
                ipc_ring::intern_command(&req.cmd),
                arg_bytes,
                crate::cmd_timing::on_main_thread(),
                corr_id,
                t_entry_ns,
                subject,
            );

            win.on_message(
                req,
                Box::new(move |_webview, _cmd, response, _callback, _error| {
                    // Response construction, byte for byte as upstream builds it
                    // (`src/ipc/protocol.rs:105-140`).
                    let response_header = match &response {
                        InvokeResponse::Ok(_) => TAURI_RESPONSE_HEADER_OK,
                        InvokeResponse::Err(_) => TAURI_RESPONSE_HEADER_ERROR,
                    };
                    let errored = matches!(response, InvokeResponse::Err(_));

                    let (mut response, mime_type): (Response<Cow<'static, [u8]>>, &str) =
                        match response {
                            InvokeResponse::Ok(InvokeResponseBody::Json(v)) => {
                                (Response::new(v.into_bytes().into()), "application/json")
                            }
                            InvokeResponse::Ok(InvokeResponseBody::Raw(v)) => {
                                (Response::new(v.into()), "application/octet-stream")
                            }
                            // Upstream `.unwrap()`s this `to_vec`. Serialising an error value can
                            // only fail for a non-string map key or a custom `Serialize` that
                            // errors, and taking the app's whole IPC down for that is not a trade
                            // worth making — so the fallback is a valid JSON string instead.
                            InvokeResponse::Err(e) => (
                                Response::new(
                                    serde_json::to_vec(&e.0)
                                        .unwrap_or_else(|_| b"\"<unserializable error>\"".to_vec())
                                        .into(),
                                ),
                                "application/json",
                            ),
                        };

                    if let Ok(v) = HeaderValue::from_str(response_header) {
                        response.headers_mut().insert(TAURI_RESPONSE_HEADER_NAME, v);
                    }
                    if let Ok(v) = HeaderValue::from_str(mime_type) {
                        response.headers_mut().insert(CONTENT_TYPE, v);
                    }

                    let ret_bytes = response.body().len().min(u32::MAX as usize) as u32;

                    // COMPLETE BEFORE RESPOND. `complete` is a handful of relaxed atomic stores, so
                    // it costs the renderer nothing measurable — and stamping after `respond` would
                    // fold the webview's own return trip into the HANDLER leg, which is precisely
                    // the confusion between "slow backend" and "slow renderer" that splitting the
                    // legs exists to resolve.
                    if let Some(ticket) = ticket {
                        ipc_ring::complete(ticket, ret_bytes, errored);
                    }
                    respond(response);
                }),
            );
        }

        Method::OPTIONS => {
            let mut r = Response::new(Cow::Owned(Vec::new()));
            r.headers_mut().insert(ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("*"));
            respond(r);
        }

        _ => {
            let mut r =
                Response::new(Cow::Owned(b"only POST and OPTIONS are allowed".to_vec()));
            *r.status_mut() = StatusCode::METHOD_NOT_ALLOWED;
            r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
            respond(r);
        }
    }
}

/// A local copy of `tauri::ipc::protocol::parse_invoke_request` (tauri-2.11.3
/// `src/ipc/protocol.rs:436-540`), minus the `isolation` branch this app cannot take.
///
/// Kept deliberately close to the original — same header names, same error strings, same
/// content-type switch — so that diffing it against a future tauri is a mechanical exercise. The
/// source guards below fail the build if the version it was copied from changes.
fn parse_invoke_request(request: Request<Vec<u8>>) -> Result<InvokeRequest, String> {
    let (parts, body) = request.into_parts();

    // skip leading `/`. Upstream indexes `[1..]` directly; `get` instead, because a panic inside
    // the IPC handler is a hung promise for the entire app and an empty path is caller-controlled.
    let cmd = percent_encoding::percent_decode(parts.uri.path().as_bytes().get(1..).unwrap_or(&[]))
        .decode_utf8_lossy()
        .to_string();

    // on Android we cannot read the request body, so an empty one is "no payload", not "no data"
    let has_payload = !body.is_empty();

    let content_type: mime::Mime = parts
        .headers
        .get(CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .map(|mime| mime.parse())
        .unwrap_or(Ok(mime::APPLICATION_OCTET_STREAM))
        .map_err(|_| "unknown content type")?;

    let invoke_key = parts
        .headers
        .get(TAURI_INVOKE_KEY_HEADER_NAME)
        .ok_or("missing Tauri-Invoke-Key header")?
        .to_str()
        .map_err(|_| "Tauri invoke key header value must be a string")?
        .to_owned();

    let url = Url::parse(
        parts
            .headers
            .get("Origin")
            .ok_or("missing Origin header")?
            .to_str()
            .map_err(|_| "Origin header value must be a string")?,
    )
    .map_err(|_| "Origin header is not a valid URL")?;

    let callback = CallbackFn(
        parts
            .headers
            .get(TAURI_CALLBACK_HEADER_NAME)
            .ok_or("missing Tauri-Callback header")?
            .to_str()
            .map_err(|_| "Tauri callback header value must be a string")?
            .parse()
            .map_err(|_| "Tauri callback header value must be a numeric string")?,
    );
    let error = CallbackFn(
        parts
            .headers
            .get(TAURI_ERROR_HEADER_NAME)
            .ok_or("missing Tauri-Error header")?
            .to_str()
            .map_err(|_| "Tauri error header value must be a string")?
            .parse()
            .map_err(|_| "Tauri error header value must be a numeric string")?,
    );

    let body = if content_type == mime::APPLICATION_OCTET_STREAM {
        body.into()
    } else if content_type == mime::APPLICATION_JSON {
        if has_payload {
            serde_json::from_slice::<serde_json::Value>(&body).map_err(|e| e.to_string())?.into()
        } else {
            serde_json::Value::Object(Default::default()).into()
        }
    } else {
        return Err(format!("content type {content_type} is not implemented"));
    };

    Ok(InvokeRequest { cmd, callback, error, url, body, headers: parts.headers, invoke_key })
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// Rust's monotonic clock, in nanos since process start.
///
/// The renderer's half of the instrument stamps in `performance.now()`, which has a DIFFERENT epoch
/// and a different drift; without a shared reading the QUEUE leg would be the difference between two
/// unrelated clocks. The renderer calls this a few times, NTP-style, and keeps the minimum
/// round-trip to estimate the offset — which only works if this command does nothing else, because
/// any work in here is indistinguishable from network delay to that estimator.
#[tauri::command]
pub async fn ipc_clock_probe() -> u64 {
    ipc_ring::now_ns()
}

/// The retained ring as a columnar JSON document.
///
/// `reset_after` starts a fresh measurement window at the instant of the dump, so a "reproduce it
/// now" workflow does not have to read past a minute of unrelated history.
#[tauri::command]
pub async fn ipc_trace_dump(reset_after: Option<bool>) -> String {
    let doc = dump_json();
    if reset_after.unwrap_or(false) {
        ipc_ring::reset();
    }
    doc
}

/// Turn the ring's killswitch. Config, not a compile gate — the instrument is ALWAYS ON in a shipped
/// build (the founder's explicit call), and this exists so a field problem can be turned off without
/// waiting for a release.
#[tauri::command]
pub async fn ipc_trace_set_enabled(enabled: bool) {
    ipc_ring::set_enabled(enabled);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Dumping
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// Everything a dump reports that is not a row, sampled once so the header cannot disagree with
/// itself.
struct Meta {
    capacity: usize,
    total_seen: u64,
    evicted: u64,
    unjoined: u64,
    in_flight: u32,
    wall_ms: u64,
    mono_ns: u64,
}

fn meta_now(rows: &[Record]) -> Meta {
    let total_seen = ipc_ring::total_seen();
    Meta {
        capacity: ipc_ring::CAPACITY,
        total_seen,
        evicted: total_seen.saturating_sub(rows.len() as u64),
        unjoined: ipc_ring::unjoined(),
        in_flight: ipc_ring::in_flight(),
        wall_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0),
        mono_ns: ipc_ring::now_ns(),
    }
}

/// The columnar document. ONE ARRAY PER FIELD rather than an array of row objects: at 16384 rows the
/// object-per-row form repeats every key 16384 times, which is most of the file and all of the
/// parse cost, for a document whose entire purpose is to be attached to a bug report.
///
/// `cmd` is an INDEX into `commands`, for the same reason.
fn render(rows: &[Record], commands: &[String], meta: &Meta) -> String {
    let n = rows.len();
    let mut rid = Vec::with_capacity(n);
    let mut corr = Vec::with_capacity(n);
    let mut cmd = Vec::with_capacity(n);
    let mut t_entry = Vec::with_capacity(n);
    let mut t_dispatch = Vec::with_capacity(n);
    let mut handler = Vec::with_capacity(n);
    let mut arg_bytes = Vec::with_capacity(n);
    let mut ret_bytes = Vec::with_capacity(n);
    let mut subject = Vec::with_capacity(n);
    let mut in_flight = Vec::with_capacity(n);
    let mut on_main = Vec::with_capacity(n);
    let mut errored = Vec::with_capacity(n);

    for r in rows {
        rid.push(r.rid);
        corr.push(r.corr_id);
        cmd.push(r.cmd_id);
        t_entry.push(r.t_entry_ns);
        t_dispatch.push(r.t_dispatch_ns);
        // `null`, never 0, for a request that has not come back — during a hang that row is the
        // most interesting one in the file and "0 ns" would read as the fastest.
        handler.push(r.handler_ns);
        arg_bytes.push(r.arg_bytes);
        ret_bytes.push(r.ret_bytes);
        // `null` for a command not on the subject allowlist, so "we did not record one" is
        // distinguishable from "this request had no session".
        subject.push(r.subject.map(ipc_ring::format_uuid));
        in_flight.push(r.in_flight);
        on_main.push(r.on_main_thread);
        errored.push(r.errored);
    }

    // THE SPAN THE FILE ACTUALLY COVERS. Capacity is in REQUESTS, not seconds: a 100-invoke burst
    // can overflow this ring in a few seconds, and a quiet app may hold an hour. Claiming a 60 s
    // window we do not have would make every rate in the file wrong.
    let oldest = rows.iter().map(|r| r.t_entry_ns).min();
    let newest = rows
        .iter()
        .map(|r| r.t_dispatch_ns.saturating_add(r.handler_ns.unwrap_or(0)))
        .max();
    let span_ns = match (oldest, newest) {
        (Some(a), Some(b)) => b.saturating_sub(a),
        _ => 0,
    };

    let doc = serde_json::json!({
        "schema": DUMP_SCHEMA,
        "capacity": meta.capacity,
        "count": n,
        "total_requests": meta.total_seen,
        "evicted": meta.evicted,
        "span_ns": span_ns,
        "span_ms": span_ns / 1_000_000,
        "oldest_entry_ns": oldest,
        "newest_observed_ns": newest,
        "unjoined": meta.unjoined,
        "in_flight": meta.in_flight,
        // The two anchors the renderer's half needs to place its own `performance.now()` stamps on
        // the same axis as `t_entry_ns` / `t_dispatch_ns`, both read at the same instant.
        "anchor": { "wall_ms": meta.wall_ms, "mono_ns": meta.mono_ns },
        "corr_encoding": "(epoch_ms as u32) << 32 | (seq as u32); 0 = renderer sent no id",
        "commands": commands,
        "rows": {
            "rid": rid,
            "corr": corr,
            "cmd": cmd,
            "t_entry_ns": t_entry,
            "t_dispatch_ns": t_dispatch,
            "handler_ns": handler,
            "arg_bytes": arg_bytes,
            "ret_bytes": ret_bytes,
            "subject": subject,
            "in_flight": in_flight,
            "on_main_thread": on_main,
            "errored": errored,
        },
    });
    // `to_string`, not `to_string_pretty`: at 16384 rows the pretty form is several times the size
    // for a file no human reads by eye anyway.
    doc.to_string()
}

/// The retained ring, rendered.
pub fn dump_json() -> String {
    let rows = ipc_ring::snapshot();
    let meta = meta_now(&rows);
    render(&rows, &ipc_ring::name_table(), &meta)
}

/// Where a hang episode's IPC timeline goes.
///
/// A SIBLING of `hang-<stamp>.txt`, sharing its stamp, so `watchdog::dump_stamp` groups it with the
/// host and renderer stacks and the existing pruner ages and evicts the whole episode together.
pub fn dump_path(dir: &Path, stamp_ms: u64) -> PathBuf {
    dir.join(format!("hang-{stamp_ms}.ipc.json"))
}

/// Write the timeline for one hang episode, and log ONE line naming the file.
///
/// One line, not one per row: `redacting_writer` runs `support::redact_secrets` — 7 regex passes —
/// over every logged line, through both sinks, and the watchdog calls this while the main thread is
/// already wedged (bead `sparkle-zllfb`).
pub fn dump_to_file(dir: &Path, stamp_ms: u64) {
    let path = dump_path(dir, stamp_ms);
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!(target: "watchdog", "could not create dump dir {dir:?}, ipc timeline skipped: {e}");
        return;
    }
    let doc = dump_json();
    let bytes = doc.len();
    match std::fs::write(&path, doc) {
        Ok(()) => tracing::info!(
            target: "watchdog",
            bytes,
            "wrote IPC timeline to {}",
            path.display()
        ),
        Err(e) => tracing::warn!(target: "watchdog", "could not write IPC timeline {path:?}: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    use tauri::http::header::{HeaderName, ORIGIN};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::WebviewWindowBuilder;

    /// One process-global ring, so tests that read it must not interleave. Locks the SAME crate-level
    /// mutex `ipc_ring`'s own tests hold (`ipc_ring::test_ring_guard`), not a per-module duplicate:
    /// both modules' tests compile into one binary and libtest runs them on parallel threads, so a
    /// separate `Mutex<()>` here would let this module's `ipc_ring::reset()`/`begin()` race
    /// `ipc_ring`'s exact-count assertions on the shared `CURSOR` and red them at random (the flake
    /// this shared lock removes).
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        ipc_ring::test_ring_guard()
    }

    /// THE COMMAND THE HEADLINE TEST RESTS ON, and it must stay `async`.
    ///
    /// A SYNC command runs its body inline inside `on_message`, so it would record ~200 ms even
    /// under the dispatch-only timing this whole module exists to replace — i.e. a sync command
    /// here would make the headline test vacuous. `async` is the discriminating case: `on_message`
    /// returns as soon as the command is spawned, so the only way ~200 ms reaches the ring is if
    /// the RESPONDER fired at completion.
    #[tauri::command]
    async fn trace_test_slow_async() -> &'static str {
        std::thread::sleep(Duration::from_millis(200));
        "done"
    }

    #[tauri::command]
    async fn trace_test_fast_async() -> &'static str {
        "quick"
    }

    fn test_app() -> tauri::App<MockRuntime> {
        mock_builder()
            .invoke_handler(tauri::generate_handler![trace_test_slow_async, trace_test_fast_async])
            .build(mock_context(noop_assets()))
            .expect("mock app builds")
    }

    /// A well-formed `ipc://` POST, exactly as the webview issues one.
    fn ipc_post(cmd: &str, body: Vec<u8>) -> Request<Vec<u8>> {
        let mut req = Request::builder().method(Method::POST).uri(format!("ipc://localhost/{cmd}"));
        let headers = req.headers_mut().expect("builder headers");
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
        headers.insert(
            HeaderName::from_str(TAURI_INVOKE_KEY_HEADER_NAME).unwrap(),
            HeaderValue::from_str(INVOKE_KEY).unwrap(),
        );
        headers.insert(
            HeaderName::from_str(TAURI_CALLBACK_HEADER_NAME).unwrap(),
            HeaderValue::from_static("0"),
        );
        headers
            .insert(HeaderName::from_str(TAURI_ERROR_HEADER_NAME).unwrap(), HeaderValue::from_static("1"));
        headers.insert(ORIGIN, HeaderValue::from_static("tauri://localhost"));
        req.body(body).expect("request builds")
    }

    /// Drive one request through the REAL handler and return the response the webview would get.
    fn round_trip(
        app: &tauri::App<MockRuntime>,
        request: Request<Vec<u8>>,
    ) -> Response<Cow<'static, [u8]>> {
        let (tx, rx) = mpsc::channel();
        handle_ipc(app.handle(), "main", request, move |response| {
            let _ = tx.send(response);
        });
        rx.recv_timeout(Duration::from_secs(10))
            .expect("the handler must ALWAYS respond — an unanswered request is a hung promise")
    }

    // ── THE HEADLINE TEST ──────────────────────────────────────────────────────────────────────
    /// An `async` command that sleeps 200 ms must record ~200 ms of HANDLER time.
    ///
    /// WHAT MUST BREAK FOR THIS TO GO RED: the completion stamp moving off the `on_message`
    /// responder. Stamp it anywhere `on_message` itself returns — which is what `cmd_timing` can
    /// see, and what any dispatch-side probe measures — and this reads a few microseconds, because
    /// an async command has only been SPAWNED by then. That gap is the entire reason this module
    /// exists: 232 of the crate's 344 commands are async, and the `bd` stall lives among them.
    ///
    /// It also goes red if `complete` is called before the command finishes, or if the ring stops
    /// deriving `handler_ns` from the two stamps.
    #[test]
    fn an_async_commands_handler_time_is_measured_at_completion_not_at_dispatch() {
        let _g = guard();
        ipc_ring::reset();
        ipc_ring::set_enabled(true);

        let app = test_app();
        WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("webview");

        let response = round_trip(&app, ipc_post("trace_test_slow_async", Vec::new()));
        assert_eq!(response.status(), StatusCode::OK, "body: {:?}", response.body());
        assert_eq!(
            response.headers().get(TAURI_RESPONSE_HEADER_NAME).map(|v| v.to_str().unwrap()),
            Some(TAURI_RESPONSE_HEADER_OK),
            "the command must have SUCCEEDED — an ACL rejection would also take ~0ms and would \
             make the duration assertion below meaningless"
        );

        let rows = ipc_ring::snapshot();
        let r = rows
            .iter()
            .find(|r| r.command == "trace_test_slow_async")
            .expect("the request must be recorded");
        let handler = r.handler_ns.expect("a completed request must carry a handler duration");
        assert!(
            handler >= 150_000_000,
            "handler must measure the ~200ms the ASYNC command actually took, got {}ms — a \
             dispatch-side stamp reads ~0 here",
            handler / 1_000_000
        );
        assert!(
            handler < 5_000_000_000,
            "…and it must be the command's own time, not the whole test's: got {}ms",
            handler / 1_000_000
        );
    }

    /// The pair to the headline test: a FAST async command must not also read as slow. Without
    /// this, a `complete` that stamped some unrelated late instant would satisfy the test above.
    #[test]
    fn a_fast_async_command_records_a_short_handler_time() {
        let _g = guard();
        ipc_ring::reset();
        ipc_ring::set_enabled(true);

        let app = test_app();
        WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("webview");
        round_trip(&app, ipc_post("trace_test_fast_async", Vec::new()));

        let rows = ipc_ring::snapshot();
        let r = rows.iter().find(|r| r.command == "trace_test_fast_async").expect("recorded");
        let handler = r.handler_ns.expect("completed");
        assert!(handler < 100_000_000, "a trivial command must not read as slow, got {handler}ns");
    }

    /// The renderer's correlation id must reach the record, so the QUEUE leg is computable.
    ///
    /// Goes red if the header name changes, if the packing changes, or if `handle_ipc` stops
    /// reading the header at all — in which case every row would be `corr = 0` and the renderer's
    /// half of the instrument would have nothing to join against.
    #[test]
    fn the_renderers_correlation_id_reaches_the_record() {
        let _g = guard();
        ipc_ring::reset();
        ipc_ring::set_enabled(true);

        let app = test_app();
        WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("webview");

        let mut request = ipc_post("trace_test_fast_async", Vec::new());
        request.headers_mut().insert(
            HeaderName::from_str(SPARKLE_IPC_HEADER_NAME).unwrap(),
            HeaderValue::from_static("1723567890123.42"),
        );
        let before = ipc_ring::unjoined();
        round_trip(&app, request);

        let rows = ipc_ring::snapshot();
        let r = rows.iter().find(|r| r.command == "trace_test_fast_async").expect("recorded");
        assert_eq!(
            r.corr_id,
            ((1723567890123u64 as u32 as u64) << 32) | 42,
            "the packed <epoch>.<seq> must reach the record"
        );
        assert_eq!(ipc_ring::unjoined(), before, "a correlated request must not count as unjoined");
    }

    /// A request with no correlation header is counted, not silently treated as joined.
    #[test]
    fn a_request_without_the_correlation_header_is_counted_as_unjoined() {
        let _g = guard();
        ipc_ring::reset();
        ipc_ring::set_enabled(true);

        let app = test_app();
        WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("webview");
        round_trip(&app, ipc_post("trace_test_fast_async", Vec::new()));

        assert_eq!(ipc_ring::unjoined(), 1, "the id-less request must have been counted");
        let rows = ipc_ring::snapshot();
        assert_eq!(rows.iter().find(|r| r.command == "trace_test_fast_async").unwrap().corr_id, 0);
    }

    /// Junk in the correlation header must not become a junk id.
    #[test]
    fn a_malformed_correlation_header_reads_as_absent() {
        let mut headers = HeaderMap::new();
        assert_eq!(correlation_id(&headers), 0, "absent header");
        for junk in ["", "nonsense", "12", "abc.def", "12.", ".34", "1.2.3"] {
            headers.insert(
                HeaderName::from_str(SPARKLE_IPC_HEADER_NAME).unwrap(),
                HeaderValue::from_str(junk).unwrap(),
            );
            assert_eq!(correlation_id(&headers), 0, "{junk:?} must read as absent");
        }
        headers.insert(
            HeaderName::from_str(SPARKLE_IPC_HEADER_NAME).unwrap(),
            HeaderValue::from_static("7.9"),
        );
        assert_eq!(correlation_id(&headers), (7u64 << 32) | 9, "…and a good one must still parse");
    }

    // ── The local copy of tauri's parser ───────────────────────────────────────────────────────
    // ── sparkle-epc1zh: the subject allowlist ─────────────────────────────────────────────────
    /// A `pty_write` entered at 03:56:23.349 with 632 arg bytes and never returned, freezing the
    /// app for 73.5 s — and nothing in the process could say WHICH terminal it was writing to.
    /// This is the extraction that answers that next time.
    #[test]
    fn subject_extraction_names_the_session_for_pty_write() {
        let id = "3bebe26e-d8f9-4eb8-80cd-1db4eacc0b7b";
        let body = format!(r#"{{"id":"{id}","data":"ls -la\n"}}"#);
        assert_eq!(
            subject_for("/pty_write", body.as_bytes()).map(ipc_ring::format_uuid).as_deref(),
            Some(id),
            "a pty_write must record WHICH session it was writing to — the fact both hang \
             captures lacked"
        );
    }

    /// The allowlist is the safety boundary: a command that is not on it records nothing, even
    /// when its payload contains a field literally named `id`.
    #[test]
    fn a_command_not_on_the_allowlist_records_no_subject() {
        let body = br#"{"id":"3bebe26e-d8f9-4eb8-80cd-1db4eacc0b7b","data":"x"}"#;
        assert_eq!(subject_for("/write_config_text", body), None);
        assert_eq!(subject_for("/frontend_log", body), None);
        assert_eq!(subject_for("/pty_kill", body), None);
        // …and the one that IS on it does record, so the assertions above are about the allowlist
        // rather than about the extractor being broken.
        assert!(subject_for("/pty_write", body).is_some());
    }

    /// The SECOND limit, independent of the allowlist: a value that is not a uuid is dropped. Even
    /// if a future entry named an argument carrying user text or a token, nothing reaches a dump.
    #[test]
    fn a_non_uuid_argument_is_dropped_rather_than_recorded() {
        for body in [
            br#"{"id":"a-credential-shaped-string-not-a-uuid","data":"x"}"#.as_slice(),
            br#"{"id":"/Users/someone/private/notes.txt","data":"x"}"#.as_slice(),
            br#"{"id":"","data":"x"}"#.as_slice(),
            br#"{"data":"x"}"#.as_slice(),
            br#"not json at all"#.as_slice(),
            b"".as_slice(),
        ] {
            assert_eq!(
                subject_for("/pty_write", body),
                None,
                "non-uuid argument must not be recorded: {:?}",
                String::from_utf8_lossy(body)
            );
        }
    }

    /// A large paste must not change the answer — the extractor is a bounded byte scan, and this
    /// pins that a realistic megabyte payload still yields the session rather than tripping over
    /// its own size.
    #[test]
    fn a_large_paste_still_yields_its_session() {
        let id = "3bebe26e-d8f9-4eb8-80cd-1db4eacc0b7b";
        let paste = "y".repeat(1024 * 1024);
        let body = format!(r#"{{"id":"{id}","data":"{paste}"}}"#);
        assert_eq!(
            subject_for("/pty_write", body.as_bytes()).map(ipc_ring::format_uuid).as_deref(),
            Some(id)
        );
    }

    #[test]
    fn json_string_field_reads_only_a_string_value() {
        assert_eq!(json_string_field(br#"{"a":"one","b":"two"}"#, "a"), Some("one"));
        assert_eq!(json_string_field(br#"{"a":"one","b":"two"}"#, "b"), Some("two"));
        assert_eq!(json_string_field(br#"{"a":"one"}"#, "missing"), None);
        // A non-string value is not a string field, so it is not returned as one.
        assert_eq!(json_string_field(br#"{"a":42}"#, "a"), None);
        // An unterminated value yields nothing rather than running off the end.
        assert_eq!(json_string_field(br#"{"a":"unterminated"#, "a"), None);
    }

    /// Round-trip, mirroring tauri's own test (`src/ipc/protocol.rs:564-644`). Goes red if any
    /// header name, the URL decode, or the content-type switch drifts from the original.
    #[test]
    fn parse_invoke_request_round_trips_both_content_types() {
        let cmd = "write_something";
        let invoke_key = "1234ahdsjkl123";
        let callback = 12378123u32;
        let error = 6243u32;

        let mut request = ipc_post(cmd, vec![123, 31, 45]);
        {
            let h = request.headers_mut();
            h.insert(
                HeaderName::from_str(TAURI_INVOKE_KEY_HEADER_NAME).unwrap(),
                HeaderValue::from_str(invoke_key).unwrap(),
            );
            h.insert(
                HeaderName::from_str(TAURI_CALLBACK_HEADER_NAME).unwrap(),
                HeaderValue::from_str(&callback.to_string()).unwrap(),
            );
            h.insert(
                HeaderName::from_str(TAURI_ERROR_HEADER_NAME).unwrap(),
                HeaderValue::from_str(&error.to_string()).unwrap(),
            );
        }
        let headers = request.headers().clone();
        let parsed = parse_invoke_request(request).expect("a well-formed request must parse");
        assert_eq!(parsed.cmd, cmd);
        assert_eq!(parsed.callback.0, callback);
        assert_eq!(parsed.error.0, error);
        assert_eq!(parsed.invoke_key, invoke_key);
        assert_eq!(parsed.url, "tauri://localhost".parse().unwrap());
        assert_eq!(parsed.headers, headers);
        // Matched rather than compared: `InvokeBody` derives `PartialEq` only inside tauri's own
        // crate, so it cannot be `assert_eq!`d from here the way tauri's own test does.
        match parsed.body {
            tauri::ipc::InvokeBody::Raw(b) => assert_eq!(b, vec![123, 31, 45]),
            other => panic!("an octet-stream body must parse as Raw, got {other:?}"),
        }

        // …and the JSON arm, which is the one the app actually uses.
        let payload = serde_json::json!({ "key": 1, "anotherKey": "asda" });
        let mut request = ipc_post(cmd, serde_json::to_vec(&payload).unwrap());
        request.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let parsed = parse_invoke_request(request).expect("JSON body must parse");
        match parsed.body {
            tauri::ipc::InvokeBody::Json(v) => assert_eq!(v, payload),
            other => panic!("an application/json body must parse as Json, got {other:?}"),
        }
    }

    /// The command is percent-decoded out of the URL path, as upstream does.
    #[test]
    fn the_command_is_percent_decoded_from_the_url_path() {
        let mut request = ipc_post("plugin%3Adeep-link%7Con_new_url", Vec::new());
        request.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let parsed = parse_invoke_request(request).expect("parses");
        assert_eq!(parsed.cmd, "plugin:deep-link|on_new_url");
    }

    // ── ANTI-VACUITY ───────────────────────────────────────────────────────────────────────────
    /// A request MISSING `Tauri-Invoke-Key` must be `Err`, not silently accepted.
    ///
    /// This is the assertion that keeps `parse_invoke_request_round_trips_both_content_types`
    /// honest: a parser that ignored every header and returned a default `InvokeRequest` would pass
    /// a round-trip written carelessly, and would hand `on_message` a key that never matches — a
    /// silent RETURN with no response, i.e. a hung promise on every invoke in the app.
    #[test]
    fn a_request_missing_its_invoke_key_is_refused() {
        let mut request = ipc_post("anything", Vec::new());
        request.headers_mut().remove(HeaderName::from_str(TAURI_INVOKE_KEY_HEADER_NAME).unwrap());
        let err = parse_invoke_request(request).expect_err("a keyless request must not parse");
        assert_eq!(err, "missing Tauri-Invoke-Key header");
    }

    /// Every other header the parser requires, likewise. Each is a distinct way a caller can be
    /// wrong, and each must be an `Err` rather than a default.
    #[test]
    fn a_request_missing_any_required_header_is_refused() {
        for (header, expected) in [
            (TAURI_CALLBACK_HEADER_NAME, "missing Tauri-Callback header"),
            (TAURI_ERROR_HEADER_NAME, "missing Tauri-Error header"),
        ] {
            let mut request = ipc_post("anything", Vec::new());
            request.headers_mut().remove(HeaderName::from_str(header).unwrap());
            assert_eq!(parse_invoke_request(request).expect_err("must be refused"), expected);
        }
        let mut request = ipc_post("anything", Vec::new());
        request.headers_mut().remove(ORIGIN);
        assert_eq!(
            parse_invoke_request(request).expect_err("must be refused"),
            "missing Origin header"
        );
        // A non-numeric callback is the other half: present, but unusable.
        let mut request = ipc_post("anything", Vec::new());
        request.headers_mut().insert(
            HeaderName::from_str(TAURI_CALLBACK_HEADER_NAME).unwrap(),
            HeaderValue::from_static("not-a-number"),
        );
        assert_eq!(
            parse_invoke_request(request).expect_err("must be refused"),
            "Tauri callback header value must be a numeric string"
        );
    }

    // ── THE SAFETY PROPERTY: a bad request FAILS, it does not HANG ─────────────────────────────
    /// A malformed request must come back as the upstream 500 + `text/plain`, WITH the CORS
    /// headers, rather than leaving the renderer's promise unsettled.
    ///
    /// WHAT MUST BREAK FOR THIS TO GO RED: any `return` in `handle_ipc` that skips `respond`. The
    /// `recv_timeout` in `round_trip` is the actual assertion — the status check below is the
    /// cheap part. This is the most important safety property in the file: an `invoke()` that never
    /// settles has no timeout and no error for the app to show, so it presents as the app being
    /// frozen, which is the very symptom this instrument was built to diagnose.
    #[test]
    fn a_malformed_request_gets_the_upstream_500_not_a_hang() {
        let _g = guard();
        let app = test_app();
        WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("webview");

        let mut request = ipc_post("trace_test_fast_async", Vec::new());
        request.headers_mut().remove(HeaderName::from_str(TAURI_INVOKE_KEY_HEADER_NAME).unwrap());

        let response = round_trip(&app, request);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            response.headers().get(CONTENT_TYPE).map(|v| v.to_str().unwrap()),
            Some("text/plain"),
            "upstream answers a parse failure with text/plain"
        );
        assert_eq!(response.body().as_ref(), b"missing Tauri-Invoke-Key header");
        assert_eq!(
            response.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).map(|v| v.to_str().unwrap()),
            Some("*"),
            "the CORS headers must be on the ERROR path too — without them the webview rejects \
             the response before reading the status, which is a hang wearing an error's clothes"
        );
    }

    /// A request naming an unknown webview label likewise responds rather than hanging.
    #[test]
    fn an_unknown_webview_label_gets_the_upstream_500_not_a_hang() {
        let _g = guard();
        let app = test_app();
        WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("webview");

        let (tx, rx) = mpsc::channel();
        handle_ipc(app.handle(), "no-such-window", ipc_post("trace_test_fast_async", Vec::new()), move |r| {
            let _ = tx.send(r);
        });
        let response = rx.recv_timeout(Duration::from_secs(5)).expect("must respond");
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(response.body().as_ref(), b"failed to acquire webview reference");
    }

    /// `OPTIONS` is the CORS preflight the webview sends before it will POST anything. Answer it
    /// wrong and NO request ever reaches the handler at all.
    #[test]
    fn an_options_preflight_is_answered_with_the_allow_headers_wildcard() {
        let _g = guard();
        let app = test_app();
        WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("webview");

        let request =
            Request::builder().method(Method::OPTIONS).uri("ipc://localhost/").body(Vec::new()).unwrap();
        let response = round_trip(&app, request);
        // 200, matching upstream's bare `http::Response::new` (`src/ipc/protocol.rs:164-171`) —
        // NOT 204, which is what a preflight conventionally returns but not what tauri sends.
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(ACCESS_CONTROL_ALLOW_HEADERS).map(|v| v.to_str().unwrap()),
            Some("*")
        );
        assert_eq!(
            response.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).map(|v| v.to_str().unwrap()),
            Some("*")
        );
    }

    /// Anything that is not POST or OPTIONS gets upstream's 405.
    #[test]
    fn an_unsupported_method_gets_the_upstream_405() {
        let _g = guard();
        let app = test_app();
        WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("webview");

        let request =
            Request::builder().method(Method::GET).uri("ipc://localhost/x").body(Vec::new()).unwrap();
        let response = round_trip(&app, request);
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(response.body().as_ref(), b"only POST and OPTIONS are allowed");
    }

    /// A command name off the wire that is not a command shape must not reach the interner
    /// verbatim — and the request must still be ANSWERED.
    #[test]
    fn a_wire_junk_command_name_is_recorded_as_the_sentinel_and_still_answered() {
        let _g = guard();
        ipc_ring::reset();
        ipc_ring::set_enabled(true);

        let app = test_app();
        WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("webview");
        // Percent-encoded so the junk survives the URL and reaches `intern_command`.
        let response = round_trip(&app, ipc_post("%3Cscript%3Ealert(1)%3C%2Fscript%3E", Vec::new()));
        assert!(response.status().is_success() || response.status().is_client_error() || response.status().is_server_error());

        let rows = ipc_ring::snapshot();
        assert!(
            rows.iter().any(|r| r.command == ipc_ring::INVALID_COMMAND),
            "junk must be recorded as the sentinel, not verbatim"
        );
        assert!(
            !rows.iter().any(|r| r.command.contains("script")),
            "caller-supplied text must never reach the dump"
        );
    }

    // ── The dump ───────────────────────────────────────────────────────────────────────────────
    /// The dump is columnar and reports the span it ACTUALLY covers.
    #[test]
    fn the_dump_is_columnar_and_reports_the_real_span_not_a_claimed_window() {
        let _g = guard();
        ipc_ring::reset();
        ipc_ring::set_enabled(true);
        let cmd = ipc_ring::intern_command("dump_shape_probe");
        for _ in 0..3 {
            let t = ipc_ring::begin(cmd, 7, false).expect("armed");
            std::thread::sleep(Duration::from_millis(10));
            ipc_ring::complete(t, 9, false);
        }

        let doc: serde_json::Value = serde_json::from_str(&dump_json()).expect("valid JSON");
        assert_eq!(doc["schema"], DUMP_SCHEMA);
        assert_eq!(doc["capacity"], ipc_ring::CAPACITY);
        assert_eq!(doc["count"], 3);

        // ONE ARRAY PER FIELD — not an array of row objects.
        let rows = &doc["rows"];
        assert!(rows["rid"].is_array(), "columnar: rows.rid must be an array");
        for field in
            ["rid", "corr", "cmd", "t_entry_ns", "t_dispatch_ns", "handler_ns", "arg_bytes", "ret_bytes", "subject"]
        {
            assert_eq!(
                rows[field].as_array().unwrap_or_else(|| panic!("{field} missing")).len(),
                3,
                "every column must be the same length as the row count"
            );
        }
        assert!(!rows.is_array(), "rows must be a struct-of-arrays, not an array of objects");

        // `cmd` is an index into the interned table, not a repeated string.
        let idx = rows["cmd"][0].as_u64().expect("cmd index") as usize;
        assert_eq!(doc["commands"][idx], "dump_shape_probe");

        // THE SPAN IS MEASURED, NOT CLAIMED. Three 10 ms requests cover ~30 ms; a header that
        // asserted "60 seconds" because that is what the capacity was sized for would make every
        // rate computed from this file wrong.
        let span_ns = doc["span_ns"].as_u64().expect("span");
        assert!(
            (25_000_000..5_000_000_000).contains(&span_ns),
            "span must be the ~30ms actually covered, got {}ms",
            span_ns / 1_000_000
        );
        assert_eq!(doc["anchor"]["mono_ns"].as_u64().is_some(), true);
        assert!(doc["anchor"]["wall_ms"].as_u64().unwrap_or(0) > 1_600_000_000_000);
    }

    /// An in-flight request must appear as `null`, never `0`. During a hang that row is the whole
    /// point of the file, and `0` would sort it as the fastest request in the dump.
    #[test]
    fn an_unfinished_request_dumps_as_null_handler_time_not_zero() {
        let _g = guard();
        ipc_ring::reset();
        ipc_ring::set_enabled(true);
        let cmd = ipc_ring::intern_command("never_returns");
        let _held = ipc_ring::begin(cmd, 0, false).expect("armed");

        let doc: serde_json::Value = serde_json::from_str(&dump_json()).expect("valid JSON");
        assert_eq!(doc["rows"]["handler_ns"][0], serde_json::Value::Null);
        assert_eq!(doc["in_flight"], 1, "the header must name the outstanding request too");
    }

    /// The evicted count must be reported, so a burst that overflowed the ring is not read as a
    /// quiet minute.
    #[test]
    fn the_dump_reports_what_it_could_not_retain() {
        let _g = guard();
        ipc_ring::reset();
        ipc_ring::set_enabled(true);
        let cmd = ipc_ring::intern_command("overflowing");
        for _ in 0..(ipc_ring::CAPACITY + 40) {
            let t = ipc_ring::begin(cmd, 0, false).expect("armed");
            ipc_ring::complete(t, 0, false);
        }
        let doc: serde_json::Value = serde_json::from_str(&dump_json()).expect("valid JSON");
        assert_eq!(doc["count"], ipc_ring::CAPACITY);
        assert_eq!(doc["evicted"], 40, "the dump must admit what it dropped");
        assert_eq!(doc["total_requests"], ipc_ring::CAPACITY as u64 + 40);
    }

    /// Counts `tracing` events on the calling thread.
    struct CountingSubscriber(Arc<AtomicUsize>);

    impl tracing::Subscriber for CountingSubscriber {
        fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
        fn event(&self, _: &tracing::Event<'_>) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
        fn enter(&self, _: &tracing::span::Id) {}
        fn exit(&self, _: &tracing::span::Id) {}
    }

    /// ONE tracing event for N rows — the redaction pathology guard.
    ///
    /// WHAT MUST BREAK FOR THIS TO GO RED: anyone adding a per-row `tracing::…!` to the dump path.
    /// `redacting_writer` runs `support::redact_secrets` — 7 regex passes — over every logged line,
    /// through both sinks, and `dump_to_file` is called by the watchdog while the main thread is
    /// ALREADY wedged (bead `sparkle-zllfb`). 500 rows is deliberately far more than one screen:
    /// a per-row log would show up here as 501, not as a rounding error.
    #[test]
    fn the_dump_emits_exactly_one_tracing_event_however_many_rows_it_holds() {
        let _g = guard();
        ipc_ring::reset();
        ipc_ring::set_enabled(true);
        let cmd = ipc_ring::intern_command("logging_probe");
        for _ in 0..500 {
            let t = ipc_ring::begin(cmd, 0, false).expect("armed");
            ipc_ring::complete(t, 0, false);
        }
        assert_eq!(ipc_ring::snapshot().len(), 500, "precondition: 500 rows to log about");

        let dir = std::env::temp_dir().join(format!("-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let count = Arc::new(AtomicUsize::new(0));
        tracing::subscriber::with_default(CountingSubscriber(count.clone()), || {
            dump_to_file(&dir, 4242);
        });
        assert_eq!(
            count.load(Ordering::Relaxed),
            1,
            "exactly one event for 500 rows — a per-row log would be 500+"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `dump_to_file` writes ONE file, named so `watchdog::dump_stamp` groups it with its episode.
    #[test]
    fn dump_to_file_writes_one_parseable_file_named_for_its_episode() {
        let _g = guard();
        ipc_ring::reset();
        ipc_ring::set_enabled(true);
        let cmd = ipc_ring::intern_command("episode_probe");
        let t = ipc_ring::begin(cmd, 1, false).expect("armed");
        ipc_ring::complete(t, 2, false);

        let dir = std::env::temp_dir().join(format!("-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dump_to_file(&dir, 987_654);

        let names: Vec<String> = std::fs::read_dir(&dir)
            .expect("dir created")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["hang-987654.ipc.json"], "one file, named for its episode");

        let body = std::fs::read_to_string(dir.join("hang-987654.ipc.json")).expect("readable");
        let doc: serde_json::Value = serde_json::from_str(&body).expect("the file must be JSON");
        assert_eq!(doc["count"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Source guards — this file reimplements a tauri internal, so a tauri bump must FAIL THE BUILD
// ─────────────────────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod source_guards {
    /// The lock file, embedded at COMPILE time — the `include_str!` source-guard trick
    /// `asset_serving.rs` uses for the manifest, pointed at the pinned version.
    const LOCK: &str = include_str!("../Cargo.lock");
    const MANIFEST: &str = include_str!("../Cargo.toml");
    const CONF: &str = include_str!("../tauri.conf.json");

    /// The exact tauri this file's copy of `parse_invoke_request` and `protocol::get` was diffed
    /// against. Bumping tauri must land here, not silently.
    const PINNED_TAURI: &str = "2.11.3";

    fn locked_version(crate_name: &str) -> Option<String> {
        let needle = format!("name = \"{crate_name}\"");
        let mut lines = LOCK.lines().map(str::trim);
        while let Some(line) = lines.next() {
            if line == needle {
                return lines.next()?.strip_prefix("version = ").map(|v| v.trim_matches('"').to_string());
            }
        }
        None
    }

    /// Every `tauri = …` declaration with the `[section]` it lives under — the same shape
    /// `asset_serving.rs` uses, and for the same reason: a `[dev-dependencies]` entry can enable a
    /// feature for `cargo test` that the shipped binary does not have, so a guard that reads only
    /// the first entry has a hole exactly where the tests run.
    fn tauri_entries() -> Vec<(String, &'static str)> {
        let mut section = String::new();
        let mut entries = Vec::new();
        for line in MANIFEST.lines().map(str::trim) {
            if line.starts_with('[') && line.ends_with(']') {
                section = line.trim_matches(['[', ']']).to_string();
            } else if line.starts_with("tauri = {") || line.starts_with("tauri = \"") {
                entries.push((section.clone(), line));
            }
        }
        assert!(!entries.is_empty(), "Cargo.toml must declare the `tauri` dependency");
        entries
    }

    /// GOES RED ON A TAURI BUMP — deliberately, and this is the whole point of the module.
    ///
    /// `ipc_trace::parse_invoke_request` is a hand copy of tauri's, and `handle_ipc` mirrors
    /// `protocol::get` response-for-response. Neither is checked by the compiler against the
    /// original, so the only thing standing between a tauri upgrade and a silently diverged IPC
    /// path is a human re-diffing `src/ipc/protocol.rs`. Failing the build is how that human finds
    /// out.
    #[test]
    fn the_pinned_tauri_is_the_one_this_file_was_copied_from() {
        assert_eq!(
            locked_version("tauri").as_deref(),
            Some(PINNED_TAURI),
            "src/ipc_trace.rs reimplements tauri's `ipc:` protocol handler and its \
             `parse_invoke_request`, copied from tauri {PINNED_TAURI}.\n\
             Cargo.lock now pins a different version, so BEFORE bumping PINNED_TAURI:\n\
               1. diff the new `src/ipc/protocol.rs` (`get` and `parse_invoke_request`) against \
                  `handle_ipc` and `parse_invoke_request` here;\n\
               2. re-check `src/manager/webview.rs` still registers tauri's own `ipc` protocol only \
                  when one is not already registered — that is what makes this shadowing work at \
                  all;\n\
               3. re-check `WebviewWindow::on_message` is still public and still fires its responder \
                  at command completion for ASYNC commands.\n\
             This is not a formality: a divergence here breaks every invoke in the app."
        );
    }

    /// `parse_invoke_request` here has NO isolation branch. Upstream's is behind
    /// `#[cfg(feature = "isolation")]` and is the only reason its version needs the `AppManager` at
    /// all — so enabling that feature without porting the branch would silently hand every command
    /// an ENCRYPTED body.
    #[test]
    fn the_tauri_dependency_does_not_enable_isolation() {
        let offenders: Vec<_> =
            tauri_entries().into_iter().filter(|(_, line)| line.contains("\"isolation\"")).collect();
        assert!(
            offenders.is_empty(),
            "`isolation` changes the IPC payload to an encrypted envelope, and \
             ipc_trace::parse_invoke_request deliberately omits the decryption branch. Port it \
             before enabling the feature. Offending entries:\n  {}",
            offenders.iter().map(|(s, l)| format!("[{s}] {l}")).collect::<Vec<_>>().join("\n  ")
        );
    }

    /// The `isolation` PATTERN is the config half of the same hazard: `tauri.conf.json` declaring
    /// `"pattern"` turns it on independently of the Cargo feature.
    #[test]
    fn the_app_config_declares_no_isolation_pattern() {
        let conf: serde_json::Value =
            serde_json::from_str(CONF).expect("tauri.conf.json must be valid JSON");
        let pattern = conf.get("app").and_then(|a| a.get("security")).and_then(|s| s.get("pattern"));
        assert!(
            pattern.is_none(),
            "tauri.conf.json now declares an isolation pattern ({pattern:?}), which encrypts the \
             IPC payload that ipc_trace::parse_invoke_request reads in the clear."
        );
        assert!(
            conf.get("pattern").is_none(),
            "tauri.conf.json declares a top-level `pattern`; see above."
        );
    }

    /// tauri's `tracing` feature would put a `serde_json::to_string` of the WHOLE request body on
    /// every invoke (`src/ipc/protocol.rs:70`) — in upstream's handler, which we shadow, but also
    /// in `parse_invoke_request`'s deserialize span and in `on_message`'s error path. This module
    /// exists to make the IPC path cheaper to observe, not more expensive.
    #[test]
    fn the_tauri_dependency_does_not_enable_tracing() {
        let offenders: Vec<_> =
            tauri_entries().into_iter().filter(|(_, line)| line.contains("\"tracing\"")).collect();
        assert!(
            offenders.is_empty(),
            "tauri's `tracing` feature serialises every invoke body to a string on the IPC path. \
             Offending entries:\n  {}",
            offenders.iter().map(|(s, l)| format!("[{s}] {l}")).collect::<Vec<_>>().join("\n  ")
        );
    }

    /// The helper above is what the three guards rest on, so prove it can actually FAIL — a
    /// `locked_version` that returned `None` for everything would make the pin test vacuous in the
    /// one direction that matters.
    #[test]
    fn locked_version_reads_the_lock_file_rather_than_always_missing() {
        assert!(
            locked_version("serde_json").is_some(),
            "the lock reader must find a crate that is definitely present"
        );
        assert_eq!(locked_version("a-crate-that-does-not-exist"), None);
    }
}
