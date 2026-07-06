//! The local orchestration bridge (Plan 2). A per-build-agent Unix-domain socket the build
//! agent's MCP server connects to. Dependency-free in the spirit of `worktree.rs`: std + serde_json,
//! std::thread for the listener (no tokio). Every request carries a per-launch token validated
//! before any work. This sub-plan (2a) serves `read_result`; later sub-plans add spawn/list/wait.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::sync::mpsc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::worktree::read_worker_result_at;

/// A registered rendezvous: the reply sender plus the build agent that owns the in-flight op.
/// The `build_agent_id` lets `stop_bridge` release EVERY pending op belonging to a build agent
/// whose bridge is being torn down (), instead of leaving those blocked accept threads
/// to wait out the full 600s round-trip timeout.
pub(crate) struct PendingEntry {
    tx: mpsc::Sender<Value>,
    build_agent_id: String,
}

/// Rendezvous map: reqId → pending entry. Used to bridge async frontend responses back to the
/// blocking accept-thread op that emitted the request. `register_pending` inserts a fresh channel
/// sender and returns the receiver; `resolve_pending` delivers the value and removes the entry.
pub type PendingMap = Arc<Mutex<HashMap<String, PendingEntry>>>;

/// Register a rendezvous for `req_id` owned by `build_agent_id`; returns the receiver the awaiting
/// op blocks on. The owner id lets a bridge teardown resolve every one of its still-blocked ops.
pub fn register_pending(pending: &PendingMap, req_id: &str, build_agent_id: &str) -> mpsc::Receiver<Value> {
    let (tx, rx) = mpsc::channel();
    // Poison-tolerant: a panic in a prior holder must not permanently wedge the bridge.
    pending.lock().unwrap_or_else(|e| e.into_inner()).insert(
        req_id.to_string(),
        PendingEntry { tx, build_agent_id: build_agent_id.to_string() },
    );
    rx
}

/// Deliver `value` to the op awaiting `req_id` (if any), removing the entry. No-op if absent or
/// the receiver was already dropped (e.g. the op timed out).
pub fn resolve_pending(pending: &PendingMap, req_id: &str, value: Value) {
    if let Some(entry) = pending.lock().unwrap_or_else(|e| e.into_inner()).remove(req_id) {
        let _ = entry.tx.send(value);
    }
}

/// Release EVERY pending op owned by `build_agent_id` (): send each blocked accept
/// thread a `null` so it returns immediately with a "round-trip timeout"-shaped None instead of
/// waiting out the full 600s timeout after its bridge was stopped. Called from `stop_bridge`.
fn resolve_pending_for_agent(pending: &PendingMap, build_agent_id: &str) {
    let mut map = pending.lock().unwrap_or_else(|e| e.into_inner());
    let stale: Vec<String> = map
        .iter()
        .filter(|(_, e)| e.build_agent_id == build_agent_id)
        .map(|(k, _)| k.clone())
        .collect();
    for k in stale {
        if let Some(entry) = map.remove(&k) {
            let _ = entry.tx.send(Value::Null);
        }
    }
}

struct BridgeHandle {
    socket_path: PathBuf,
    token: String,
    shutdown: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    /// The per-launch token of the AgentPane run that currently owns this bridge ().
    /// Each `prepare()` run mints a fresh launch token; `stop_bridge` only tears the bridge down
    /// when the caller presents THIS owner's token, so a stale run's teardown (a sub-second
    /// close-reopen, or a superseded prepare()) can't destroy a NEWER run's live bridge.
    owner: String,
}

#[derive(Default)]
pub struct BridgeManager {
    bridges: Mutex<HashMap<String, BridgeHandle>>,
    pending: PendingMap,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    socket_path: String,
    token: String,
}

/// Bind the per-build-agent socket (0600), spawn the accept loop, return (socket_path, token).
/// Idempotent: a second call for the same build_agent_id returns the existing socket + token.
/// `app` is `Option<AppHandle>` so Rust unit tests (no Tauri runtime) can pass `None`; production
/// passes `Some(app)`. The AppHandle is cloned into the accept thread for 2b-C's async ops.
pub fn start_bridge_at(
    app: Option<AppHandle>,
    manager: &BridgeManager,
    app_data: &Path,
    project_id: &str,
    build_agent_id: &str,
    launch_token: &str,
) -> Result<(PathBuf, String), String> {
    // Hold the lock across check → bind → insert so two concurrent starts for the same
    // build_agent_id can't both bind (the loser would orphan a thread whose shutdown flag
    // stop_bridge could never signal). The accept thread we spawn doesn't take this lock,
    // so holding it here can't deadlock.
    // Poison-tolerant: a panic in a prior holder must not permanently wedge bridge start/stop.
    let mut map = manager.bridges.lock().unwrap_or_else(|e| e.into_inner());
    // FIX 2: idempotency check — only return the existing handle if its accept loop is still alive.
    // If the loop died (fatal error branch), treat as stale: tear down and fall through to rebind.
    if let Some(h) = map.get_mut(build_agent_id) {
        if h.alive.load(Ordering::SeqCst) {
            // : a re-prepare() of the same build agent reuses the live bridge, but it is
            // now owned by the NEWEST launch. Transfer ownership so a still-pending teardown from the
            // PRIOR launch (which presents the old token) becomes a no-op and can't kill this bridge.
            h.owner = launch_token.to_string();
            return Ok((h.socket_path.clone(), h.token.clone()));
        }
        let _ = std::fs::remove_file(&h.socket_path); // stale/dead listener — tear down + rebind below
        map.remove(build_agent_id);
    }
    let sock = bridge_socket_path(app_data, project_id, build_agent_id);
    if let Some(parent) = sock.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir socket parent dir: {e}"))?;
    }
    // FIX 1: while still holding the lock, check whether any OTHER handle already uses this socket
    // path (a different build_agent_id whose first-16-hex prefix collides with this one). If so,
    // return Err without touching the file — we must not stomp a live socket belonging to someone else.
    if map.values().any(|h| h.socket_path == sock) {
        return Err(format!(
            "socket path collision: {} already in use by another build agent",
            sock.display()
        ));
    }
    // FIX B: generate token BEFORE bind so a failure here can't leave a socket file behind.
    let token = generate_token()?;
    let _ = std::fs::remove_file(&sock); // clear any stale socket
    let listener = UnixListener::bind(&sock).map_err(|e| format!("bind {sock:?}: {e}"))?;
    // FIX B: clean up socket file on post-bind failures.
    std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| { let _ = std::fs::remove_file(&sock); format!("chmod socket: {e}") })?;

    let shutdown = Arc::new(AtomicBool::new(false));
    // FIX 2: observable liveness flag — the accept loop sets this to false before it exits
    // (both the shutdown break and the fatal-error break), so callers can detect a dead loop.
    let alive = Arc::new(AtomicBool::new(true));

    // Non-blocking accept loop so the shutdown flag is observed promptly between polls.
    // FIX B: clean up socket file if set_nonblocking fails.
    listener.set_nonblocking(true).map_err(|e| { let _ = std::fs::remove_file(&sock); format!("set_nonblocking: {e}") })?;
    let token_t = token.clone();
    let shutdown_t = shutdown.clone();
    let alive_t = alive.clone();
    let app_t = app.clone();
    let pending_t = manager.pending.clone();
    let build_id_t = build_agent_id.to_string();
    let project_id_t = project_id.to_string();
    std::thread::spawn(move || loop {
        if shutdown_t.load(Ordering::SeqCst) {
            alive_t.store(false, Ordering::SeqCst); // FIX 2: mark dead before shutdown break
            break;
        }
        match listener.accept() {
            Ok((stream, _addr)) => {
                let token_c = token_t.clone();
                let app_c = app_t.clone();
                let pending_c = pending_t.clone();
                let build_c = build_id_t.clone();
                let project_c = project_id_t.clone();
                std::thread::spawn(move || serve_conn(stream, &token_c, app_c, pending_c, build_c, project_c));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            // FIX A: transient errors — keep the loop alive.
            Err(ref e) if e.kind() == std::io::ErrorKind::ConnectionAborted
                       || e.kind() == std::io::ErrorKind::Interrupted => {
                continue;
            }
            // FIX A: fatal errors — log and exit the loop.
            Err(e) => {
                eprintln!("[bridge] accept loop exiting on fatal error: {e}");
                alive_t.store(false, Ordering::SeqCst); // FIX 2: mark dead before fatal-error break
                break;
            }
        }
    });

    map.insert(
        build_agent_id.to_string(),
        BridgeHandle {
            socket_path: sock.clone(),
            token: token.clone(),
            shutdown,
            alive,
            owner: launch_token.to_string(),
        },
    );
    Ok((sock, token))
}

/// Read newline-delimited requests on one connection; write one response per request.
/// `app`/`pending`/`build_agent_id`/`project_id` are the connection's authoritative context:
/// frontend round-trip ops (spawn_worker/list_workers/spin_down) emit events and await replies
/// via this context; synchronous ops (read_result) delegate to `handle_request_line`.
///
/// One-request-per-connection assumption: `BridgeClient` (apps/mcp-orchestrator) opens a fresh
/// Unix socket per call and never pipelines multiple requests on the same connection.  The loop
/// below can handle multiple lines in principle, but the 600s blocking wait in the frontend
/// round-trip ops would head-of-line-block any subsequent lines — callers must NOT pipeline.
fn serve_conn(
    stream: UnixStream,
    token: &str,
    app: Option<AppHandle>,
    pending: PendingMap,
    build_agent_id: String,
    project_id: String,
) {
    // An accepted stream inherits the listener's non-blocking mode; make it blocking so the
    // per-connection BufReader::lines() reads normally.
    stream.set_nonblocking(false).ok();
    let peer = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut writer = peer;
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        if line.trim().is_empty() { continue; }
        let resp = handle_request_line_ctx(&line, token, &app, &pending, &build_agent_id, &project_id);
        if writeln!(writer, "{resp}").is_err() { break; }
    }
}

/// Signal shutdown, remove the socket file and the map entry, and release every op still blocked
/// on this bridge (). `launch_token` is the per-launch owner token the caller started
/// the bridge with: teardown happens ONLY when it matches the current owner (or is `None`, an
/// unconditional stop). A stale run presenting an old token is a no-op — it can't tear down a
/// NEWER launch's live bridge (the sub-second close-reopen / superseded-prepare race).
pub fn stop_bridge(manager: &BridgeManager, build_agent_id: &str, launch_token: Option<&str>) {
    let mut map = manager.bridges.lock().unwrap_or_else(|e| e.into_inner());
    // Only tear down when this caller owns the current bridge (or forces it with None).
    let owns = match (map.get(build_agent_id), launch_token) {
        (Some(h), Some(tok)) => h.owner == tok,
        (Some(_), None) => true,
        (None, _) => false,
    };
    if !owns {
        return;
    }
    if let Some(h) = map.remove(build_agent_id) {
        h.shutdown.store(true, Ordering::SeqCst);
        let _ = std::fs::remove_file(&h.socket_path);
    }
    // Drop the map lock BEFORE resolving pending ops so a woken accept thread can't contend on it.
    drop(map);
    // Release any blocked round-trip ops owned by this build agent so their accept threads return
    // immediately instead of waiting out the 600s timeout.
    resolve_pending_for_agent(&manager.pending, build_agent_id);
}

/// The git SHA this binary was built from (sparkle-bnvs), embedded at compile time by build.rs.
/// "unknown" when git was unavailable at build (e.g. a tarball build). The running app embeds the
/// MCP/bridge and does NOT hot-reload, so this is the signal that reveals a stale running build.
pub fn running_build_sha() -> &'static str {
    option_env!("SPARKLE_GIT_SHA").unwrap_or("unknown")
}

/// Append a line to the durable orchestration log under app-data (sparkle-bnvs). Best-effort:
/// a logging failure never affects bridge start/stop. Gives spawn/reconcile/bridge lifecycle a
/// durable, greppable trail (`<app_data>/orchestration.log`) that survives the app restart the
/// stale-build trap requires — so "which build was running when this went wrong" is answerable.
pub fn append_orch_log(app_data: &Path, line: &str) {
    use std::io::Write as _;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = app_data.join("orchestration.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{ts} sha={} {line}", running_build_sha());
    }
}

/// Per-build-agent socket path. macOS caps Unix socket paths at ~104 bytes (`sockaddr_un.sun_path`),
/// and `<app_data>/sockets/<projectId>-<buildAgentId>.sock` (~147 bytes with UUIDs) blows past that
/// — `bind()` would fail with ENAMETOOLONG. So the socket lives in the per-user temp dir
/// (`$TMPDIR`, a 0700 per-user dir on macOS) under a short name derived from the build agent id
/// (itself a globally-unique UUID). `app_data`/`project_id` are accepted for signature stability
/// with the Tauri command but are intentionally NOT part of the length-constrained path.
pub fn bridge_socket_path(_app_data: &Path, _project_id: &str, build_agent_id: &str) -> PathBuf {
    let short: String = build_agent_id.chars().filter(|c| *c != '-').take(16).collect();
    std::env::temp_dir().join(format!("sparkle-orch-{short}.sock"))
}

/// 32 lowercase-hex chars (16 random bytes) from /dev/urandom. Dependency-free.
pub fn generate_token() -> Result<String, String> {
    let mut f = std::fs::File::open("/dev/urandom").map_err(|e| format!("urandom open: {e}"))?;
    let mut buf = [0u8; 16];
    f.read_exact(&mut buf).map_err(|e| format!("urandom read: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Start the orchestration bridge for a build agent (Tauri command).
#[tauri::command]
pub fn start_orchestration_bridge(
    app: AppHandle,
    manager: State<BridgeManager>,
    project_id: String,
    build_agent_id: String,
    launch_token: String,
) -> Result<BridgeInfo, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    let (sock, token) =
        start_bridge_at(Some(app.clone()), &manager, &app_data, &project_id, &build_agent_id, &launch_token)?;
    // sparkle-bnvs: durable record of which build served this bridge start (embeds the SHA).
    append_orch_log(&app_data, &format!("bridge_start build={build_agent_id} project={project_id}"));
    Ok(BridgeInfo { socket_path: sock.to_string_lossy().to_string(), token })
}

/// Stop the orchestration bridge for a build agent (Tauri command). `launch_token` is the
/// per-launch owner token: teardown only happens when it matches the current owner, so a stale
/// run's cleanup can't kill a newer run's bridge ().
#[tauri::command]
pub fn stop_orchestration_bridge(
    app: AppHandle,
    manager: State<BridgeManager>,
    build_agent_id: String,
    launch_token: String,
) -> Result<(), String> {
    stop_bridge(&manager, &build_agent_id, Some(&launch_token));
    if let Ok(app_data) = crate::worktree::app_data_dir_pub(&app) {
        append_orch_log(&app_data, &format!("bridge_stop build={build_agent_id}"));
    }
    Ok(())
}

/// Absolute paths the build-agent launch needs to wire its MCP server (Plan 2c): the `node`
/// binary, and the bundled orchestrator `server.js`. Resolved in Rust because the bundled resource
/// path is only knowable via Tauri's resource resolver and node must be found off the login shell.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPaths {
    node_path: String,
    server_path: String,
}

/// Resolve the node binary + the bundled mcp-orchestrator server.js (Tauri command).
#[tauri::command]
pub fn orchestrator_mcp_paths(app: AppHandle) -> Result<McpPaths, String> {
    let node_path = crate::preflight::resolve_node_path_cached()
        .ok_or_else(|| "node not found (install Node.js; needed to run the orchestrator)".to_string())?;
    let server = app
        .path()
        .resolve(
            "resources/mcp-orchestrator-server.js",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("orchestrator server.js missing: {e}"))?;
    if !server.exists() {
        return Err(format!(
            "orchestrator server.js not bundled at {} (run apps/desktop build to copy it)",
            server.display()
        ));
    }
    Ok(McpPaths {
        node_path,
        server_path: server.to_string_lossy().to_string(),
    })
}

/// Deliver a frontend response back to the op that is blocking on `req_id` (Tauri command).
/// Called by the frontend after handling an `orchestration:request` event emitted by 2b-C ops.
#[tauri::command]
pub fn orchestration_respond(
    manager: State<BridgeManager>,
    req_id: String,
    result: Value,
) -> Result<(), String> {
    resolve_pending(&manager.pending, &req_id, result);
    Ok(())
}

/// Pure request handler: one request JSON line → one response JSON line. No socket IO, so it is
/// directly unit-testable. Validates the token, then dispatches by `op`.
fn handle_request_line(line: &str, expected_token: &str) -> String {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({ "id": Value::Null, "ok": false, "error": format!("bad json: {e}") }).to_string(),
    };
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    if req.get("token").and_then(|t| t.as_str()) != Some(expected_token) {
        return json!({ "id": id, "ok": false, "error": "unauthorized" }).to_string();
    }
    match req.get("op").and_then(|o| o.as_str()) {
        Some("read_result") => {
            // ACCEPTED EXCEPTION — path is NOT bounded to the build agent's own workers here.
            // Unlike spawn_worker/list_workers/spin_down, which are identity-injected by
            // handle_request_line_ctx (the bridge injects the authoritative buildAgentId from
            // the socket handle), read_result uses the caller-supplied `worktree` path verbatim.
            // This is intentional in a single-user, token-gated trust model: the only caller is
            // the MCP orchestrator child process, which already holds the per-launch secret token
            // and only reads .sparkle/result.json — it cannot write or escape the path.
            // Bounding the path to the project worktree root is a tracked follow-up (see code review).
            let wt = req.get("worktree").and_then(|w| w.as_str()).unwrap_or("");
            match read_worker_result_at(Path::new(wt)) {
                Ok(opt) => json!({ "id": id, "ok": true,
                    "result": { "present": opt.is_some(), "json": opt } }).to_string(),
                Err(e) => json!({ "id": id, "ok": false, "error": e }).to_string(),
            }
        }
        Some("bridge_info") => {
            // sparkle-bnvs: report the running build so the orchestrator (or a developer) can tell
            // whether the live app embeds a stale bridge — the app does NOT hot-reload, so a fix on
            // main isn't live until a restart. `sha` is baked in at compile time (build.rs).
            json!({ "id": id, "ok": true, "result": {
                "sha": running_build_sha(),
                "pid": std::process::id(),
            } }).to_string()
        }
        _ => json!({ "id": id, "ok": false, "error": "unknown op" }).to_string(),
    }
}

/// Frontend round-trip timeout. Long enough to cover a spawn_worker that the listener queues
/// behind the concurrency cap, yet bounded so a genuinely stuck frontend eventually releases the
/// connection thread (the 2a-deferred read-timeout concern, now load-bearing for these ops).
const ROUNDTRIP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// Block on a rendezvous receiver. On timeout, remove the now-stale pending entry (so a late
/// orchestration_respond for this reqId is a harmless no-op) and return None.
fn wait_pending(
    rx: std::sync::mpsc::Receiver<Value>,
    pending: &PendingMap,
    req_id: &str,
    timeout: std::time::Duration,
) -> Option<Value> {
    match rx.recv_timeout(timeout) {
        Ok(v) => Some(v),
        Err(_) => {
            resolve_pending(pending, req_id, Value::Null); // drop the stale sender entry
            None
        }
    }
}

/// Handle a frontend round-trip op: register a fresh reqId BEFORE emitting (so a fast frontend
/// reply can't race ahead of registration), emit the Tauri event with the AUTHORITATIVE identity
/// from this socket's build-agent handle, then await the reply. The caller's message never carries
/// buildAgentId/projectId — the bridge supplies them, closing the cross-agent/confused-deputy gap.
fn handle_frontend_op(
    id: Value,
    op: &str,
    req: &Value,
    app: &Option<AppHandle>,
    pending: &PendingMap,
    build_agent_id: &str,
    project_id: &str,
) -> String {
    // Validate required fields BEFORE the app handle check so a malformed request fails fast
    // (no 600s hang) regardless of whether a Tauri app is present.
    let payload = match op {
        "spawn_worker" => {
            let task = req.get("task").and_then(|t| t.as_str()).unwrap_or("");
            if task.is_empty() {
                return json!({ "id": id, "ok": false, "error": "missing task" }).to_string();
            }
            // Forward an optional beadId so the frontend can link the worker to the bead it
            // implements (Think→Plan→Build). Identity fields stay bridge-injected; this is data.
            match req.get("beadId").and_then(|b| b.as_str()) {
                Some(bead_id) => json!({ "task": task, "beadId": bead_id }),
                None => json!({ "task": task }),
            }
        }
        "spin_down" => {
            let worker_id = req.get("workerId").and_then(|w| w.as_str()).unwrap_or("");
            if worker_id.is_empty() {
                return json!({ "id": id, "ok": false, "error": "missing workerId" }).to_string();
            }
            json!({ "workerId": worker_id })
        }
        _ => json!({}), // list_workers needs no payload
    };
    let app = match app {
        Some(a) => a,
        None => return json!({ "id": id, "ok": false, "error": "no app handle" }).to_string(),
    };
    let req_id = match generate_token() {
        Ok(t) => t,
        Err(e) => return json!({ "id": id, "ok": false, "error": format!("reqId gen: {e}") }).to_string(),
    };
    let rx = register_pending(pending, &req_id, build_agent_id);
    let event = json!({
        "reqId": req_id,
        "op": op,
        "buildAgentId": build_agent_id,
        "projectId": project_id,
        "payload": payload,
    });
    if let Err(e) = app.emit("orchestration:request", event) {
        resolve_pending(pending, &req_id, Value::Null); // clean up the entry we just registered
        return json!({ "id": id, "ok": false, "error": format!("emit failed: {e}") }).to_string();
    }
    match wait_pending(rx, pending, &req_id, ROUNDTRIP_TIMEOUT) {
        Some(mut val) => {
            // sparkle-bnvs: stamp every list_workers reply with the running build SHA so the
            // orchestrator sees on each poll which build is live and can flag a stale one.
            if op == "list_workers" {
                if let Some(obj) = val.as_object_mut() {
                    obj.insert("runningSha".to_string(), json!(running_build_sha()));
                }
            }
            json!({ "id": id, "ok": true, "result": val }).to_string()
        }
        None => json!({ "id": id, "ok": false, "error": "frontend round-trip timeout" }).to_string(),
    }
}

/// Auth + dispatch with the connection's context. Frontend ops round-trip through the React layer;
/// everything else (read_result, unknown) delegates to the pure sync `handle_request_line`.
fn handle_request_line_ctx(
    line: &str,
    token: &str,
    app: &Option<AppHandle>,
    pending: &PendingMap,
    build_agent_id: &str,
    project_id: &str,
) -> String {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({ "id": Value::Null, "ok": false, "error": format!("bad json: {e}") }).to_string(),
    };
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    if req.get("token").and_then(|t| t.as_str()) != Some(token) {
        return json!({ "id": id, "ok": false, "error": "unauthorized" }).to_string();
    }
    match req.get("op").and_then(|o| o.as_str()) {
        Some(op @ ("spawn_worker" | "list_workers" | "spin_down")) => {
            handle_frontend_op(id, op, &req, app, pending, build_agent_id, project_id)
        }
        // read_result + unknown op: the existing pure sync handler (re-validates the token, which
        // we already passed; cheap and keeps the 2a/2b-A unit tests of handle_request_line valid).
        _ => handle_request_line(line, token),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    // FIX D: per-call counter so two tests in the same binary can't collide even if they share a prefix.
    static UNIQUE_DIR_CTR: AtomicU64 = AtomicU64::new(0);

    fn unique_dir(tag: &str) -> PathBuf {
        let n = UNIQUE_DIR_CTR.fetch_add(1, AtomicOrdering::Relaxed);
        let d = std::env::temp_dir().join(format!("sparkle-bridge-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn socket_path_is_short_and_temp_based() {
        // Short id (no dashes to strip) → name is the id verbatim.
        let p = bridge_socket_path(Path::new("/tmp/appdata"), "proj", "build1");
        assert_eq!(p, std::env::temp_dir().join("sparkle-orch-build1.sock"));
        // A real UUID build agent id: dashes stripped, first 16 hex chars; path must fit macOS
        // sun_path (~104 bytes) even though app_data + full UUIDs would not.
        let p2 = bridge_socket_path(
            Path::new("/tmp/appdata"),
            "proj",
            "e4a0cd29-525c-4ce7-8214-8e0411385b5e",
        );
        assert_eq!(p2, std::env::temp_dir().join("sparkle-orch-e4a0cd29525c4ce7.sock"));
        assert!(p2.to_string_lossy().len() < 104, "socket path must fit macOS sun_path");
    }

    #[test]
    fn generate_token_is_32_hex_chars_and_varies() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "tokens must not be constant");
    }

    #[test]
    fn handle_request_rejects_bad_token() {
        let resp = handle_request_line(
            r#"{"id":"1","token":"WRONG","op":"read_result","worktree":"/x"}"#,
            "RIGHT",
        );
        let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["id"], "1");
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "unauthorized");
    }

    #[test]
    fn handle_request_read_result_none_then_some() {
        let dir = unique_dir("read");
        let req_none = format!(
            r#"{{"id":"2","token":"T","op":"read_result","worktree":"{}"}}"#,
            dir.to_string_lossy()
        );
        let v: serde_json::Value = serde_json::from_str(&handle_request_line(&req_none, "T")).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"]["present"], false);

        let sparkle = dir.join(".sparkle");
        std::fs::create_dir_all(&sparkle).unwrap();
        std::fs::write(sparkle.join("result.json"), r#"{"ok":1}"#).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&handle_request_line(&req_none, "T")).unwrap();
        assert_eq!(v2["ok"], true);
        assert_eq!(v2["result"]["present"], true);
        assert_eq!(v2["result"]["json"], r#"{"ok":1}"#);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn handle_request_unknown_op() {
        let v: serde_json::Value =
            serde_json::from_str(&handle_request_line(r#"{"id":"3","token":"T","op":"nope"}"#, "T")).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "unknown op");
    }

    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    /// Scratch dir for the socket-binding tests. The bound socket's path no longer depends on this
    /// dir (it lives in temp_dir under a short name — see bridge_socket_path), so this is just a
    /// normal unique temp dir; uses std::env::temp_dir() (not a hardcoded /tmp) for portability.
    /// Appends a per-call counter to prevent collisions between tests in the same binary.
    fn short_unique_dir(prefix: &str) -> PathBuf {
        let n = UNIQUE_DIR_CTR.fetch_add(1, AtomicOrdering::Relaxed);
        let d = std::env::temp_dir().join(format!("sb-{prefix}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn listener_serves_authed_read_result_and_rejects_bad_token() {
        let app_data = short_unique_dir("lad");
        let mgr = BridgeManager::default();
        let (sock, token) = start_bridge_at(None, &mgr, &app_data, "p", "build1", "L1").unwrap();
        // 0600 perms on the socket file.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "socket must be owner-only");
        }

        // A worktree with a result.json to read back.
        let wt = short_unique_dir("lwt");
        let sp = wt.join(".sparkle");
        std::fs::create_dir_all(&sp).unwrap();
        std::fs::write(sp.join("result.json"), r#"{"status":"success"}"#).unwrap();

        // Authed request → ok + contents.
        let mut stream = UnixStream::connect(&sock).unwrap();
        let req = format!(
            r#"{{"id":"1","token":"{token}","op":"read_result","worktree":"{}"}}"#,
            wt.to_string_lossy()
        );
        writeln!(stream, "{req}").unwrap();
        let mut reader = BufReader::new(stream);
        let mut resp = String::new();
        reader.read_line(&mut resp).unwrap();
        let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"]["json"], r#"{"status":"success"}"#);

        // Bad token → unauthorized.
        let mut s2 = UnixStream::connect(&sock).unwrap();
        writeln!(s2, r#"{{"id":"2","token":"NOPE","op":"read_result","worktree":"/x"}}"#).unwrap();
        let mut r2 = BufReader::new(s2);
        let mut resp2 = String::new();
        r2.read_line(&mut resp2).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&resp2).unwrap();
        assert_eq!(v2["ok"], false);
        assert_eq!(v2["error"], "unauthorized");

        stop_bridge(&mgr, "build1", None);
        assert!(!sock.exists(), "socket file removed on stop");
        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&wt);
    }

    // FIX C — idempotency: a second start_bridge_at for the same id returns the same (path, token).
    #[test]
    fn start_bridge_at_is_idempotent() {
        let app_data = short_unique_dir("idem");
        let mgr = BridgeManager::default();
        let (sock1, token1) = start_bridge_at(None, &mgr, &app_data, "p", "idem-agent", "L1").unwrap();
        let (sock2, token2) = start_bridge_at(None, &mgr, &app_data, "p", "idem-agent", "L1").unwrap();
        assert_eq!(sock1, sock2, "idempotent: same socket path");
        assert_eq!(token1, token2, "idempotent: same token");
        stop_bridge(&mgr, "idem-agent", None);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // FIX C — post-stop: connecting to the old socket path fails after stop_bridge.
    #[test]
    fn connect_fails_after_stop_bridge() {
        let app_data = short_unique_dir("stop");
        let mgr = BridgeManager::default();
        let (sock, _token) = start_bridge_at(None, &mgr, &app_data, "p", "stop-agent", "L1").unwrap();
        // Confirm we can connect before stop.
        assert!(UnixStream::connect(&sock).is_ok(), "should connect before stop");
        stop_bridge(&mgr, "stop-agent", None);
        // After stop the socket file is gone; connect must fail.
        assert!(UnixStream::connect(&sock).is_err(), "must not connect after stop");
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // FIX 2 — stale-handle rebind: if a handle's accept loop has died (alive=false), a subsequent
    // start_bridge_at for the same id must rebind and return a FRESH token (not the stale one).
    #[test]
    fn stale_dead_handle_is_rebound() {
        let app_data = short_unique_dir("stale");
        let mgr = BridgeManager::default();
        let (_sock1, token1) = start_bridge_at(None, &mgr, &app_data, "p", "stale-agent", "L1").unwrap();

        // Reach into the manager and flip alive to false — simulating a fatal accept-loop exit.
        {
            let map = mgr.bridges.lock().unwrap();
            let h = map.get("stale-agent").expect("handle must exist after start");
            h.alive.store(false, Ordering::SeqCst);
        }

        // A second call for the same id must detect the dead handle, tear it down, and rebind.
        let (_sock2, token2) = start_bridge_at(None, &mgr, &app_data, "p", "stale-agent", "L2").unwrap();
        assert_ne!(token1, token2, "fresh bind must produce a new token, not the stale one");

        stop_bridge(&mgr, "stale-agent", None);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    //  — stale teardown must NOT kill a live bridge. A stop presenting a token that is
    // not the current owner is a no-op; the correct owner's stop tears it down.
    #[test]
    fn stop_bridge_ignores_stale_launch_token() {
        let app_data = short_unique_dir("s16a");
        let mgr = BridgeManager::default();
        let (sock, _tok) = start_bridge_at(None, &mgr, &app_data, "p", "s16-agent", "L1").unwrap();
        assert!(UnixStream::connect(&sock).is_ok(), "connect before any stop");
        // A stale run (old token) tries to stop it — must be a no-op.
        stop_bridge(&mgr, "s16-agent", Some("STALE"));
        assert!(UnixStream::connect(&sock).is_ok(), "stale-token stop must NOT tear down the bridge");
        // The real owner stops it — now it's gone.
        stop_bridge(&mgr, "s16-agent", Some("L1"));
        assert!(UnixStream::connect(&sock).is_err(), "owner stop tears the bridge down");
        let _ = std::fs::remove_dir_all(&app_data);
    }

    //  — a re-prepare() of the same build agent transfers ownership to the newest launch,
    // so the PRIOR launch's still-pending teardown becomes a no-op and can't kill the live bridge.
    #[test]
    fn reprepare_transfers_ownership_stale_stop_is_noop() {
        let app_data = short_unique_dir("s16b");
        let mgr = BridgeManager::default();
        let (sock1, tok1) = start_bridge_at(None, &mgr, &app_data, "p", "s16b-agent", "L1").unwrap();
        // Idempotent re-start under a NEWER launch token: same socket/token, ownership moves to L2.
        let (sock2, tok2) = start_bridge_at(None, &mgr, &app_data, "p", "s16b-agent", "L2").unwrap();
        assert_eq!(sock1, sock2, "reused live bridge keeps its socket");
        assert_eq!(tok1, tok2, "reused live bridge keeps its token");
        // The OLD launch's teardown fires (old token) — must NOT tear down the bridge L2 now owns.
        stop_bridge(&mgr, "s16b-agent", Some("L1"));
        assert!(UnixStream::connect(&sock1).is_ok(), "prior launch's stop must be a no-op after ownership transfer");
        // The current owner's stop works.
        stop_bridge(&mgr, "s16b-agent", Some("L2"));
        assert!(UnixStream::connect(&sock1).is_err(), "current owner stop tears it down");
        let _ = std::fs::remove_dir_all(&app_data);
    }

    //  — stop_bridge releases every op still blocked on the torn-down bridge so its
    // accept thread returns immediately instead of hanging for the full 600s round-trip timeout.
    #[test]
    fn stop_bridge_releases_pending_ops() {
        let app_data = short_unique_dir("s16c");
        let mgr = BridgeManager::default();
        // A live bridge for agentA (its accept thread is what would otherwise block on the pendings).
        let _ = start_bridge_at(None, &mgr, &app_data, "p", "agentA", "L1").unwrap();
        // Two pending ops for agentA, one for a bystander agentB that must survive the stop.
        let rx_a1 = register_pending(&mgr.pending, "a1", "agentA");
        let rx_a2 = register_pending(&mgr.pending, "a2", "agentA");
        let rx_b = register_pending(&mgr.pending, "b1", "agentB");
        // The owner stops agentA's bridge — every one of agentA's blocked ops is released with null.
        stop_bridge(&mgr, "agentA", Some("L1"));
        assert_eq!(rx_a1.recv_timeout(std::time::Duration::from_secs(2)).unwrap(), Value::Null);
        assert_eq!(rx_a2.recv_timeout(std::time::Duration::from_secs(2)).unwrap(), Value::Null);
        // The bystander's op is untouched — its entry remains and it receives no value.
        assert!(rx_b.recv_timeout(std::time::Duration::from_millis(50)).is_err());
        assert!(mgr.pending.lock().unwrap().contains_key("b1"), "bystander pending must survive");
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // sparkle-bnvs — bridge_info reports the running build SHA (token-gated) so the orchestrator
    // can detect a stale running build (the app embeds the bridge and does not hot-reload).
    #[test]
    fn bridge_info_reports_running_sha() {
        let v: serde_json::Value = serde_json::from_str(
            &handle_request_line(r#"{"id":"1","token":"T","op":"bridge_info"}"#, "T"),
        )
        .unwrap();
        assert_eq!(v["ok"], true);
        assert!(v["result"]["sha"].is_string(), "sha must be present");
        assert!(v["result"]["pid"].is_number(), "pid must be present");
        // Unauthorized without the token.
        let bad: serde_json::Value = serde_json::from_str(
            &handle_request_line(r#"{"id":"1","token":"X","op":"bridge_info"}"#, "T"),
        )
        .unwrap();
        assert_eq!(bad["error"], "unauthorized");
    }

    // sparkle-bnvs — the durable orchestration log appends a line under app-data and stamps the SHA.
    #[test]
    fn append_orch_log_writes_line() {
        let dir = short_unique_dir("olog");
        append_orch_log(&dir, "bridge_start build=x project=y");
        let contents = std::fs::read_to_string(dir.join("orchestration.log")).unwrap();
        assert!(contents.contains("bridge_start build=x project=y"));
        assert!(contents.contains("sha="), "log line must carry the running SHA");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_register_resolve_roundtrip_and_timeout() {
        use std::time::Duration;
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

        // Register, resolve from another thread, receive the value.
        let rx = register_pending(&pending, "req1", "b");
        let p2 = pending.clone();
        std::thread::spawn(move || {
            resolve_pending(&p2, "req1", serde_json::json!({ "workerId": "w1" }));
        });
        let got = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(got["workerId"], "w1");

        // Unresolved request times out.
        let rx2 = register_pending(&pending, "req2", "b");
        assert!(rx2.recv_timeout(Duration::from_millis(50)).is_err());

        // Resolving an unknown id is a no-op (does not panic).
        resolve_pending(&pending, "nonexistent", serde_json::json!(null));
    }

    #[test]
    fn pending_map_recovers_after_poison() {
        // Poison the pending map by panicking while holding its lock, then assert register/resolve
        // still work. Without poison-tolerant acquisition, every later bridge op would panic for the
        // rest of the process (the permanently-wedged-command bug this hardening closes).
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let p2 = pending.clone();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = p2.lock().unwrap();
            panic!("simulated panic while holding the pending lock");
        }));
        // Lock is now poisoned; the poison-tolerant register/resolve must still function.
        let rx = register_pending(&pending, "after-poison", "b");
        resolve_pending(&pending, "after-poison", serde_json::json!({ "ok": true }));
        let got = rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        assert_eq!(got["ok"], true);
    }

    #[test]
    fn wait_pending_resolves_then_times_out() {
        use std::time::Duration;
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

        // Resolved before the timeout → Some(value).
        let rx = register_pending(&pending, "rp1", "b");
        let p2 = pending.clone();
        std::thread::spawn(move || resolve_pending(&p2, "rp1", serde_json::json!({ "ok": 1 })));
        let got = wait_pending(rx, &pending, "rp1", Duration::from_secs(2));
        assert_eq!(got, Some(serde_json::json!({ "ok": 1 })));

        // Never resolved → None, and the stale pending entry is removed.
        let rx2 = register_pending(&pending, "rp2", "b");
        let none = wait_pending(rx2, &pending, "rp2", Duration::from_millis(20));
        assert_eq!(none, None);
        assert!(!pending.lock().unwrap().contains_key("rp2"), "stale entry must be removed on timeout");
    }

    #[test]
    fn frontend_op_validates_required_fields() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        // spawn_worker with missing task → fast-fail, no hang
        let resp = handle_request_line_ctx(
            r#"{"id":"8","token":"T","op":"spawn_worker"}"#,
            "T", &None, &pending, "b", "p",
        );
        let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "missing task");
        // spawn_worker with empty string task → same
        let resp2 = handle_request_line_ctx(
            r#"{"id":"9","token":"T","op":"spawn_worker","task":""}"#,
            "T", &None, &pending, "b", "p",
        );
        let v2: serde_json::Value = serde_json::from_str(&resp2).unwrap();
        assert_eq!(v2["error"], "missing task");
        // spin_down with missing workerId → fast-fail
        let resp3 = handle_request_line_ctx(
            r#"{"id":"10","token":"T","op":"spin_down"}"#,
            "T", &None, &pending, "b", "p",
        );
        let v3: serde_json::Value = serde_json::from_str(&resp3).unwrap();
        assert_eq!(v3["error"], "missing workerId");
        // No pending entries were registered (no hanging round-trips started)
        assert!(pending.lock().unwrap().is_empty(), "no pending entries from validation failures");
    }

    #[test]
    fn frontend_op_without_app_handle_errors() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let line = r#"{"id":"7","token":"T","op":"spawn_worker","task":"do it"}"#;
        let resp = handle_request_line_ctx(line, "T", &None, &pending, "build1", "proj1");
        let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["id"], "7");
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "no app handle");
    }

    #[test]
    fn mcp_paths_serializes_camel_case() {
        // The frontend (Task 5 --mcp-config) depends on these exact key names.
        let p = McpPaths {
            node_path: "/usr/local/bin/node".to_string(),
            server_path: "/app/resources/mcp-orchestrator-server.js".to_string(),
        };
        let v: serde_json::Value = serde_json::to_value(&p).unwrap();
        assert_eq!(v["nodePath"], "/usr/local/bin/node");
        assert_eq!(v["serverPath"], "/app/resources/mcp-orchestrator-server.js");
        // No snake_case leakage.
        assert!(v.get("node_path").is_none());
        assert!(v.get("server_path").is_none());
    }

    #[test]
    fn ctx_serves_read_result_and_auth_with_none_app() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        // Bad token → unauthorized even through the ctx path.
        let bad = handle_request_line_ctx(
            r#"{"id":"1","token":"WRONG","op":"read_result","worktree":"/x"}"#,
            "RIGHT", &None, &pending, "b", "p",
        );
        let vb: serde_json::Value = serde_json::from_str(&bad).unwrap();
        assert_eq!(vb["error"], "unauthorized");

        // read_result still works (delegates to the sync handler) with a None app handle.
        let dir = unique_dir("ctx-read");
        let req = format!(
            r#"{{"id":"2","token":"T","op":"read_result","worktree":"{}"}}"#,
            dir.to_string_lossy()
        );
        let v: serde_json::Value =
            serde_json::from_str(&handle_request_line_ctx(&req, "T", &None, &pending, "b", "p")).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"]["present"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
