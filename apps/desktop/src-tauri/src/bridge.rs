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

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::worktree::read_worker_result_at;

struct BridgeHandle {
    socket_path: PathBuf,
    token: String,
    shutdown: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct BridgeManager {
    bridges: Mutex<HashMap<String, BridgeHandle>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    socket_path: String,
    token: String,
}

/// Bind the per-build-agent socket (0600), spawn the accept loop, return (socket_path, token).
/// Idempotent: a second call for the same build_agent_id returns the existing socket + token.
pub fn start_bridge_at(
    manager: &BridgeManager,
    app_data: &Path,
    project_id: &str,
    build_agent_id: &str,
) -> Result<(PathBuf, String), String> {
    // Hold the lock across check → bind → insert so two concurrent starts for the same
    // build_agent_id can't both bind (the loser would orphan a thread whose shutdown flag
    // stop_bridge could never signal). The accept thread we spawn doesn't take this lock,
    // so holding it here can't deadlock.
    let mut map = manager.bridges.lock().unwrap();
    // FIX 2: idempotency check — only return the existing handle if its accept loop is still alive.
    // If the loop died (fatal error branch), treat as stale: tear down and fall through to rebind.
    if let Some(h) = map.get(build_agent_id) {
        if h.alive.load(Ordering::SeqCst) {
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
    std::thread::spawn(move || loop {
        if shutdown_t.load(Ordering::SeqCst) {
            alive_t.store(false, Ordering::SeqCst); // FIX 2: mark dead before shutdown break
            break;
        }
        match listener.accept() {
            Ok((stream, _addr)) => {
                let token_c = token_t.clone();
                std::thread::spawn(move || serve_conn(stream, &token_c));
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
        BridgeHandle { socket_path: sock.clone(), token: token.clone(), shutdown, alive },
    );
    Ok((sock, token))
}

/// Read newline-delimited requests on one connection; write one response per request.
fn serve_conn(stream: UnixStream, token: &str) {
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
        let resp = handle_request_line(&line, token);
        if writeln!(writer, "{resp}").is_err() { break; }
    }
}

/// Signal shutdown, remove the socket file and the map entry.
pub fn stop_bridge(manager: &BridgeManager, build_agent_id: &str) {
    if let Some(h) = manager.bridges.lock().unwrap().remove(build_agent_id) {
        h.shutdown.store(true, Ordering::SeqCst);
        let _ = std::fs::remove_file(&h.socket_path);
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
) -> Result<BridgeInfo, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    let (sock, token) = start_bridge_at(&manager, &app_data, &project_id, &build_agent_id)?;
    Ok(BridgeInfo { socket_path: sock.to_string_lossy().to_string(), token })
}

/// Stop the orchestration bridge for a build agent (Tauri command).
#[tauri::command]
pub fn stop_orchestration_bridge(manager: State<BridgeManager>, build_agent_id: String) -> Result<(), String> {
    stop_bridge(&manager, &build_agent_id);
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
            let wt = req.get("worktree").and_then(|w| w.as_str()).unwrap_or("");
            match read_worker_result_at(Path::new(wt)) {
                Ok(opt) => json!({ "id": id, "ok": true,
                    "result": { "present": opt.is_some(), "json": opt } }).to_string(),
                Err(e) => json!({ "id": id, "ok": false, "error": e }).to_string(),
            }
        }
        _ => json!({ "id": id, "ok": false, "error": "unknown op" }).to_string(),
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
        let (sock, token) = start_bridge_at(&mgr, &app_data, "p", "build1").unwrap();
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

        stop_bridge(&mgr, "build1");
        assert!(!sock.exists(), "socket file removed on stop");
        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&wt);
    }

    // FIX C — idempotency: a second start_bridge_at for the same id returns the same (path, token).
    #[test]
    fn start_bridge_at_is_idempotent() {
        let app_data = short_unique_dir("idem");
        let mgr = BridgeManager::default();
        let (sock1, token1) = start_bridge_at(&mgr, &app_data, "p", "idem-agent").unwrap();
        let (sock2, token2) = start_bridge_at(&mgr, &app_data, "p", "idem-agent").unwrap();
        assert_eq!(sock1, sock2, "idempotent: same socket path");
        assert_eq!(token1, token2, "idempotent: same token");
        stop_bridge(&mgr, "idem-agent");
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // FIX C — post-stop: connecting to the old socket path fails after stop_bridge.
    #[test]
    fn connect_fails_after_stop_bridge() {
        let app_data = short_unique_dir("stop");
        let mgr = BridgeManager::default();
        let (sock, _token) = start_bridge_at(&mgr, &app_data, "p", "stop-agent").unwrap();
        // Confirm we can connect before stop.
        assert!(UnixStream::connect(&sock).is_ok(), "should connect before stop");
        stop_bridge(&mgr, "stop-agent");
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
        let (_sock1, token1) = start_bridge_at(&mgr, &app_data, "p", "stale-agent").unwrap();

        // Reach into the manager and flip alive to false — simulating a fatal accept-loop exit.
        {
            let map = mgr.bridges.lock().unwrap();
            let h = map.get("stale-agent").expect("handle must exist after start");
            h.alive.store(false, Ordering::SeqCst);
        }

        // A second call for the same id must detect the dead handle, tear it down, and rebind.
        let (_sock2, token2) = start_bridge_at(&mgr, &app_data, "p", "stale-agent").unwrap();
        assert_ne!(token1, token2, "fresh bind must produce a new token, not the stale one");

        stop_bridge(&mgr, "stale-agent");
        let _ = std::fs::remove_dir_all(&app_data);
    }
}
