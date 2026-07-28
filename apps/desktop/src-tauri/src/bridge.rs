//! The local orchestration bridge (Plan 2). A per-build-agent Unix-domain socket the build
//! agent's MCP server connects to. Dependency-free in the spirit of `worktree.rs`: std + serde_json,
//! std::thread for the listener (no tokio). Every request carries a per-launch token validated
//! before any work. This sub-plan (2a) serves `read_result`; later sub-plans add spawn/list/wait.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::sync::mpsc;

use serde::{Deserialize, Serialize};
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
    // FIX B: resolve the token BEFORE bind so a failure here can't leave a socket file behind.
    // sparkle-i95d: REUSE this agent's persisted token when it has one — so a rebind (a dead-handle
    // rebind in THIS process, or a boot-time reconcile after an app restart) is transparent to an
    // MCP client whose frozen env still holds the original token. Only mint a fresh token for an
    // agent with none on record yet. Persisted below, after the bind + insert succeed.
    let token = match persisted_bridge_token(app_data, build_agent_id) {
        Some(t) => t,
        None => generate_token()?,
    };
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
    // sparkle-i95d: record the stable (project, token) AFTER a successful bind + insert, so a rebind
    // (dead-handle in this process, or a boot reconcile after restart) reuses this exact token and a
    // surviving MCP client keeps validating. Idempotent — a reused token just rewrites the same value.
    persist_bridge_entry(app_data, build_agent_id, project_id, &token);
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
/// Returns `true` when this call actually tore the bridge down, `false` on a stale-token / absent
/// no-op — so the caller (`stop_orchestration_bridge`) only forgets the persisted token on a REAL
/// teardown, never on a sub-second close-reopen where the agent is coming back (sparkle-i95d).
pub fn stop_bridge(manager: &BridgeManager, build_agent_id: &str, launch_token: Option<&str>) -> bool {
    let mut map = manager.bridges.lock().unwrap_or_else(|e| e.into_inner());
    // Only tear down when this caller owns the current bridge (or forces it with None).
    let owns = match (map.get(build_agent_id), launch_token) {
        (Some(h), Some(tok)) => h.owner == tok,
        (Some(_), None) => true,
        (None, _) => false,
    };
    if !owns {
        return false;
    }
    let torn = if let Some(h) = map.remove(build_agent_id) {
        h.shutdown.store(true, Ordering::SeqCst);
        let _ = std::fs::remove_file(&h.socket_path);
        true
    } else {
        false
    };
    // Drop the map lock BEFORE resolving pending ops so a woken accept thread can't contend on it.
    drop(map);
    // Release any blocked round-trip ops owned by this build agent so their accept threads return
    // immediately instead of waiting out the 600s timeout.
    resolve_pending_for_agent(&manager.pending, build_agent_id);
    torn
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

// --- sparkle-i95d: durable per-agent bridge registry ------------------------------------------
// A build agent's bridge token used to be minted fresh on every bind and held only in memory, so an
// app restart (which drops the in-memory BridgeManager and orphans the socket file) left a still-
// running MCP client pointing at a dead socket AND — even once something rebound it — holding a token
// the fresh bind had rotated away. Persisting `(project_id, token)` per build agent fixes both:
//   * the token is now STABLE across rebinds (reused from disk), so a surviving client's frozen env
//     keeps validating after a rebind; and
//   * the host can enumerate every agent at boot and rebind its socket (reconcile_bridges_at) without
//     waiting for the agent's pane to remount.
// The file (`<app_data>/orch-bridges.json`, 0600 — the same owner-only posture as the socket) is
// written best-effort: any IO/parse failure degrades to "no persisted state" (mint a fresh token,
// reconcile nothing) rather than blocking bridge start.

/// Serializes read-modify-write of the registry file so two agents starting concurrently can't
/// lost-update each other's entries (the file is process-shared; the per-agent `bridges` lock only
/// guards a single agent's start). Const-initialized so it needs no lazy setup.
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

/// Per-write uniquifier for the registry temp file. Callers already hold REGISTRY_LOCK (so writes are
/// serialized), but keying the temp name on this counter as well means a future caller that forgets
/// the lock still can't have two concurrent writes clobber the same temp path.
static REGISTRY_TMP_CTR: AtomicUsize = AtomicUsize::new(0);

#[derive(Serialize, Deserialize, Clone)]
struct PersistedBridge {
    project_id: String,
    token: String,
}

fn bridge_registry_path(app_data: &Path) -> PathBuf {
    app_data.join("orch-bridges.json")
}

/// Read the registry (build_agent_id → {project_id, token}). Best-effort: a missing or unparseable
/// file is treated as empty, never an error.
fn read_bridge_registry(app_data: &Path) -> HashMap<String, PersistedBridge> {
    match std::fs::read_to_string(bridge_registry_path(app_data)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Persist the registry atomically at 0600. The file holds every agent's bridge token in plaintext,
/// so it must NEVER pass through a world-readable state: create a temp sibling with mode 0600 from
/// the first byte (no write-then-chmod TOCTOU window), write + fsync, then rename over the target —
/// which also gives readers an all-or-nothing view (no torn read). Best-effort — a failure just means
/// we fall back to a fresh token / lazy rebind next time.
fn write_bridge_registry(app_data: &Path, map: &HashMap<String, PersistedBridge>) {
    let Ok(json) = serde_json::to_string(map) else { return };
    let path = bridge_registry_path(app_data);
    // pid guards against two app instances colliding; the per-write counter guards against any
    // intra-process concurrency (defense-in-depth beyond REGISTRY_LOCK).
    let tmp = path.with_file_name(format!(
        "orch-bridges.json.tmp.{}.{}",
        std::process::id(),
        REGISTRY_TMP_CTR.fetch_add(1, Ordering::Relaxed),
    ));
    let opened = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp);
    let Ok(mut f) = opened else { return };
    if f.write_all(json.as_bytes()).is_ok() && f.sync_all().is_ok() {
        // Clean the temp up on a rename failure too, so a failed swap can't accumulate orphans.
        if std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// This build agent's previously-persisted token, if any. `None` → first bind for this agent (mint).
fn persisted_bridge_token(app_data: &Path, build_agent_id: &str) -> Option<String> {
    let _g = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_bridge_registry(app_data).get(build_agent_id).map(|e| e.token.clone())
}

/// Record this agent's stable `(project, token)` so a later rebind or boot reconcile reuses it.
fn persist_bridge_entry(app_data: &Path, build_agent_id: &str, project_id: &str, token: &str) {
    let _g = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = read_bridge_registry(app_data);
    map.insert(
        build_agent_id.to_string(),
        PersistedBridge { project_id: project_id.to_string(), token: token.to_string() },
    );
    write_bridge_registry(app_data, &map);
}

/// Forget an agent's persisted bridge on a REAL teardown, so a closed agent isn't rebound at the
/// next boot. Only called when stop actually tore the bridge down (not on a stale-token no-op stop).
fn remove_persisted_bridge(app_data: &Path, build_agent_id: &str) {
    let _g = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = read_bridge_registry(app_data);
    if map.remove(build_agent_id).is_some() {
        write_bridge_registry(app_data, &map);
    }
}

/// Forget the persisted token IFF the stop actually tore the bridge down. Extracted from
/// `stop_orchestration_bridge` so the torn→forget wiring is unit-testable without a Tauri runtime:
/// a stale-token no-op stop (torn=false, the sub-second close-reopen race) MUST keep the entry so the
/// reopen reuses the same token; a real teardown (torn=true) forgets it so a closed agent isn't
/// rebound at the next boot.
fn forget_persisted_if_torn(app_data: &Path, build_agent_id: &str, torn: bool) {
    if torn {
        remove_persisted_bridge(app_data, build_agent_id);
    }
}

/// sparkle-i95d: at app boot, rebind every persisted build agent's socket so live-worker control
/// survives an app restart WITHOUT waiting for the agent's pane to remount. Best-effort per agent
/// (one failure never aborts the rest). Each rebind reuses the persisted (stable) token, so a still-
/// running MCP client's frozen env keeps validating; the owner is seeded to that token and the
/// agent's next `prepare()` transfers ownership to its own launch token. Returns the count rebound.
pub fn reconcile_bridges_at(app: Option<AppHandle>, manager: &BridgeManager, app_data: &Path) -> usize {
    let registry = {
        let _g = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        read_bridge_registry(app_data)
    };
    let mut rebound = 0usize;
    for (build_agent_id, entry) in registry {
        match start_bridge_at(app.clone(), manager, app_data, &entry.project_id, &build_agent_id, &entry.token) {
            Ok(_) => {
                rebound += 1;
                append_orch_log(app_data, &format!("bridge_reconcile build={build_agent_id} project={}", entry.project_id));
            }
            Err(e) => append_orch_log(app_data, &format!("bridge_reconcile_failed build={build_agent_id} err={e}")),
        }
    }
    rebound
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
    let torn = stop_bridge(&manager, &build_agent_id, Some(&launch_token));
    if let Ok(app_data) = crate::worktree::app_data_dir_pub(&app) {
        // sparkle-i95d: only forget the persisted token on a REAL teardown. A stale-token no-op stop
        // (the sub-second close-reopen race) must keep the entry so the reopen reuses the same token.
        forget_persisted_if_torn(&app_data, &build_agent_id, torn);
        append_orch_log(&app_data, &format!("bridge_stop build={build_agent_id} torn={torn}"));
    }
    Ok(())
}

/// Absolute paths the build-agent launch needs to wire its MCP server (Plan 2c): the `node`
/// binary, and the bundled orchestrator `server.js`. Resolved in Rust because the bundled resource
/// path is only knowable via Tauri's resource resolver and node must be found off the login shell.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPaths {
    // pub(crate) so `concierge.rs` can build its own `--mcp-config` from these without going
    // through the Tauri command boundary (it runs in-process, not from the WebView).
    pub(crate) node_path: String,
    pub(crate) server_path: String,
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

// ============================================================================
// sparkle-control: a SINGLETON, app-level control bridge.
//
// Where the orchestration bridge above is strictly per-Build-agent (one socket + token per build
// agent, identity derived from *which socket you connected to*), the control bridge is the opposite
// shape: ONE socket + ONE token per app launch, shared by ALL agent kinds (Think, Build, worker).
// It lets the user's own Claude Code drive the desktop UI first-person (name itself, narrate what
// it's building, adjust theme/config) via a sibling `sparkle-control` MCP.
//
// Because THAT socket is shared, identity cannot be derived from the connection. Instead every op
// carries an explicit `callerAgentId` in the request JSON (the MCP server stamps it from its
// per-agent SPARKLE_AGENT_ID env var). The bridge passes `callerAgentId` through to the frontend
// event verbatim; it does NOT trust any id nested inside `payload`, and it does NOT attempt to
// derive identity from the socket. Anti-spoofing is preserved by injecting SPARKLE_AGENT_ID into
// each agent's control-MCP env at spawn (frontend's job), not by anything on this shared socket.
//
// ALL control ops (the Phase-1 self-report/config set + the Phase-3 breadth ops: pin/unpin/model/
// ordering/zoom/navigate) are frontend round-trips: the bridge emits a `control:request` event,
// blocks on the shared pending rendezvous, and returns whatever `control_respond` resolves. This
// reuses the exact register_pending/wait_pending/resolve_pending primitives + ROUNDTRIP_TIMEOUT as
// the orchestrator — so a new op is just a name added to CONTROL_OPS + a frontend dispatch case.
//
// THERE IS A SECOND CONTROL SOCKET (bead `sparkle-9a8j`): the concierge brain's. It is not an agent
// tab — it is a headless `claude -p` child — so it has no SPARKLE_AGENT_ID to stamp and would fail
// every privileged check. It therefore gets its own listener, its own token, and an identity the
// bridge stamps SERVER-SIDE from the socket the connection arrived on (`ControlCaller`), which is
// the same "confused-deputy closed by construction" shape the orchestrator bridge uses for
// buildAgentId. See `CONCIERGE_CALLER_AGENT_ID` and `resolve_control_caller`.

/// The allow-listed control ops. Anything else is rejected with "unknown op". This is only the
/// COARSE existence gate — the finer free-vs-privileged safety tier is enforced frontend-side in
/// controlListener's CONTROL_OP_TIERS (the skill only *advises*; see the PRD safety-gating note).
const CONTROL_OPS: &[&str] = &[
    // Phase 1 (self-report + read/config).
    "get_state",
    "rename_agent",
    "set_agent_activity",
    "set_theme",
    "get_config",
    "set_config",
    // Phase 3 (breadth: ordering/zoom/model/navigation).
    "pin_agent",
    "unpin_agent",
    "set_agent_model",
    "set_agent_ordering",
    "set_zoom",
    "navigate",
    // Phase 4 (the concierge tool surface). ONE generic op rather than ~55 named ones: the
    // frontend registry (services/conciergeTools/registry.ts) routes { domain, op, args } to the
    // right domain module. Deliberate — every MCP tool schema is permanently resident in the
    // concierge's context and it re-spawns per turn, so a wide named surface costs real tokens
    // on every single turn. The fine-grained allow/ask/deny decision is made frontend-side on
    // the INNER `op`, not on this outer name.
    "concierge_tool",
];

/// Fields the bridge owns on the wire; everything else in the request becomes the op `payload`.
const CONTROL_RESERVED_FIELDS: &[&str] = &["id", "token", "op", "callerAgentId"];

/// The RESERVED caller id for the concierge brain (bead `sparkle-9a8j`, design A7.3).
///
/// The concierge is not an agent tab — it is a headless `claude -p` child (`concierge.rs`) — so it
/// can never resolve through `controlListener.findAgent`, and `callerMayAdminister` denies every
/// unresolvable caller by design. Rather than weakening that fail-closed check for everyone, the
/// concierge gets an identity that is STRUCTURAL rather than claimed: it connects on its OWN control
/// socket, and every request arriving there is stamped with this id server-side, whatever the client
/// sent. A request on the SHARED socket that merely *claims* this id is rejected outright — so the
/// id cannot be minted by anything except this process, on that socket. Same "confused-deputy closed
/// by construction" shape as the orchestrator bridge deriving buildAgentId from the socket handle.
///
/// The colon makes it unmistakably NOT an agent-tab id (those are UUIDs), so it can never collide.
///
/// MIRRORED in `apps/desktop/src/services/controlListener.ts` as `CONCIERGE_CALLER_AGENT_ID`; the
/// two literals must stay in step and `concierge_caller_id_is_mirrored_in_typescript` asserts it.
pub const CONCIERGE_CALLER_AGENT_ID: &str = "sparkle:concierge";

/// WHICH control socket a request arrived on — the sole source of caller identity truth.
///
/// This is deliberately not a value carried in the request: a client can lie about a field, it
/// cannot lie about which listener accepted its connection.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ControlCaller {
    /// The singleton app-level socket, shared by every agent kind. Identity is the top-level
    /// `callerAgentId` the MCP server stamped from its per-agent `SPARKLE_AGENT_ID`.
    Shared,
    /// The concierge's dedicated socket. Identity is ALWAYS `CONCIERGE_CALLER_AGENT_ID`.
    Concierge,
}

struct ControlBridgeHandle {
    socket_path: PathBuf,
    token: String,
    shutdown: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
}

/// Singleton state for the app-level control bridge. `inner` caches the one live SHARED handle
/// (None until the first `start_control_bridge`), `concierge` the one live CONCIERGE handle (None
/// until the first `start_concierge_control_bridge`); `pending` is the shared reqId→reply rendezvous
/// map, cloned into every serve thread exactly like `BridgeManager::pending`.
///
/// One `pending` map for BOTH sockets is deliberate and safe: reqIds are freshly generated 32-hex
/// tokens, so they never collide across sockets, and `control_respond` resolves by reqId alone —
/// the frontend does not (and must not) need to know which socket a request came in on.
#[derive(Default)]
pub struct ControlBridgeManager {
    inner: Mutex<Option<ControlBridgeHandle>>,
    concierge: Mutex<Option<ControlBridgeHandle>>,
    pending: PendingMap,
}

/// The handle slot for a socket kind. Each kind is its own independent singleton: its own socket
/// path, its own token, its own accept loop.
fn control_slot(manager: &ControlBridgeManager, caller: ControlCaller) -> &Mutex<Option<ControlBridgeHandle>> {
    match caller {
        ControlCaller::Shared => &manager.inner,
        ControlCaller::Concierge => &manager.concierge,
    }
}

/// Control socket path: `sparkle-ctrl-<16hex>.sock` (shared) / `sparkle-conc-<16hex>.sock`
/// (concierge) in the per-user temp dir (`$TMPDIR`, 0700 on macOS). Short random suffix keeps the
/// path under macOS's ~104-byte `sun_path` cap — the same constraint that forces the orchestrator
/// socket into temp_dir. The two prefixes are the same length, so both stay within the cap.
fn control_socket_path(caller: ControlCaller, hex: &str) -> PathBuf {
    let prefix = match caller {
        ControlCaller::Shared => "sparkle-ctrl",
        ControlCaller::Concierge => "sparkle-conc",
    };
    std::env::temp_dir().join(format!("{prefix}-{hex}.sock"))
}

/// Start (or return the cached) singleton SHARED app-level control bridge. See
/// `start_control_bridge_kind`.
pub fn start_control_bridge_at(
    app: Option<AppHandle>,
    manager: &ControlBridgeManager,
) -> Result<(PathBuf, String), String> {
    start_control_bridge_kind(app, manager, ControlCaller::Shared)
}

/// Start (or return the cached) singleton CONCIERGE control bridge — a second listener on its own
/// socket path with its own independently-minted token. Every request that arrives here is stamped
/// with `CONCIERGE_CALLER_AGENT_ID`; nothing on the shared socket can claim that identity. Nothing
/// launches a client against it yet (bead `sparkle-9a8j` is identity only — wiring the concierge's
/// MCP child is the next phase); it exists so that caller is representable and authorized.
pub fn start_concierge_control_bridge_at(
    app: Option<AppHandle>,
    manager: &ControlBridgeManager,
) -> Result<(PathBuf, String), String> {
    start_control_bridge_kind(app, manager, ControlCaller::Concierge)
}

/// Start (or return the cached) singleton control bridge for one socket kind. Idempotent: the first
/// call binds the socket, spawns the accept loop, and caches {socketPath, token}; every subsequent
/// call returns the SAME socket + token while the accept loop is alive. If the loop died
/// (fatal-error branch), the stale handle is torn down and a fresh one is bound. `app` is
/// `Option<AppHandle>` so unit tests (no Tauri runtime) can pass `None`; production passes
/// `Some(app)`.
///
/// The two kinds share nothing but the `pending` map: separate slots, separate sockets, separate
/// tokens. `caller` is captured by the accept loop and handed to every connection it serves, which
/// is what makes concierge identity structural — it is a property of the listener, not of the wire.
fn start_control_bridge_kind(
    app: Option<AppHandle>,
    manager: &ControlBridgeManager,
    caller: ControlCaller,
) -> Result<(PathBuf, String), String> {
    // Hold the lock across check → bind → cache so two concurrent starts can't both bind (the loser
    // would orphan a thread whose shutdown flag stop_control_bridge could never signal). The accept
    // thread never takes this lock, so holding it here can't deadlock.
    let mut guard = control_slot(manager, caller).lock().unwrap_or_else(|e| e.into_inner());
    if let Some(h) = guard.as_ref() {
        if h.alive.load(Ordering::SeqCst) {
            return Ok((h.socket_path.clone(), h.token.clone()));
        }
        // Dead loop — treat as stale: signal any lingering accept thread to exit (so a later
        // stop_control_bridge isn't the only thing that could set it), remove the socket file,
        // and fall through to rebind.
        h.shutdown.store(true, Ordering::SeqCst);
        let _ = std::fs::remove_file(&h.socket_path);
        *guard = None;
    }
    // Generate token + random socket suffix BEFORE bind so a failure here leaves no socket file.
    let token = generate_token()?;
    let suffix: String = generate_token()?.chars().take(16).collect();
    let sock = control_socket_path(caller, &suffix);
    let _ = std::fs::remove_file(&sock); // clear any stale socket
    let listener = UnixListener::bind(&sock).map_err(|e| format!("bind {sock:?}: {e}"))?;
    std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| { let _ = std::fs::remove_file(&sock); format!("chmod control socket: {e}") })?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let alive = Arc::new(AtomicBool::new(true));

    listener
        .set_nonblocking(true)
        .map_err(|e| { let _ = std::fs::remove_file(&sock); format!("set_nonblocking: {e}") })?;
    let token_t = token.clone();
    let shutdown_t = shutdown.clone();
    let alive_t = alive.clone();
    let app_t = app.clone();
    let pending_t = manager.pending.clone();
    std::thread::spawn(move || loop {
        if shutdown_t.load(Ordering::SeqCst) {
            alive_t.store(false, Ordering::SeqCst);
            break;
        }
        match listener.accept() {
            Ok((stream, _addr)) => {
                let token_c = token_t.clone();
                let app_c = app_t.clone();
                let pending_c = pending_t.clone();
                std::thread::spawn(move || serve_control_conn(stream, &token_c, caller, app_c, pending_c));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::ConnectionAborted
                       || e.kind() == std::io::ErrorKind::Interrupted => {
                continue;
            }
            Err(e) => {
                eprintln!("[control-bridge {caller:?}] accept loop exiting on fatal error: {e}");
                alive_t.store(false, Ordering::SeqCst);
                break;
            }
        }
    });

    *guard = Some(ControlBridgeHandle { socket_path: sock.clone(), token: token.clone(), shutdown, alive });
    Ok((sock, token))
}

/// Signal shutdown, remove the socket file, and clear the cached handle for BOTH control sockets.
/// Idempotent no-op for a kind that was never started. Stopping "the control bridge" must take the
/// concierge listener down with it — leaving a live socket behind after the app tore the surface
/// down would be a privileged listener nobody is tracking.
///
/// ASYMMETRY NOTE (roborev 54164, finding 3). This stops both, while the frontend's only start
/// path (`startControlBridge`) revives only the SHARED one — which would strand the concierge on a
/// removed socket and a dead token. That gap is closed on the concierge's side rather than here:
/// `concierge::resolve_concierge_mcp_config` calls `start_concierge_control_bridge_at` (idempotent)
/// on EVERY turn and rewrites the child's 0600 `--mcp-config` from the CURRENT socket+token before
/// spawning it. So a stop can at worst cost the in-flight turn its control surface — it degrades to
/// observe-only and logs why — and the next turn re-establishes everything.
///
/// This holds ONLY because the concierge child is spawned per turn and never outlives one. If the
/// concierge ever becomes a long-lived child, that child WILL hold a stale token across a stop, and
/// this needs a real fix (scope the stop to the shared bridge + a separate concierge stop command).
fn stop_control_bridge_inner(manager: &ControlBridgeManager) {
    for caller in [ControlCaller::Shared, ControlCaller::Concierge] {
        if let Some(h) = control_slot(manager, caller).lock().unwrap_or_else(|e| e.into_inner()).take() {
            h.shutdown.store(true, Ordering::SeqCst);
            let _ = std::fs::remove_file(&h.socket_path);
        }
    }
}

/// Read newline-delimited control requests on one connection; write one response per request.
/// Unlike the orchestrator's `serve_conn`, there is no per-connection AGENT context — the shared
/// socket carries identity in each request's `callerAgentId` field instead. There IS a per-listener
/// `caller` kind, though, and it is what decides whether that field is trusted at all.
fn serve_control_conn(
    stream: UnixStream,
    token: &str,
    caller: ControlCaller,
    app: Option<AppHandle>,
    pending: PendingMap,
) {
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
        let resp = handle_control_request_line(&line, token, caller, &app, &pending);
        if writeln!(writer, "{resp}").is_err() { break; }
    }
}

/// Build the op `payload` = the request object minus the bridge-owned reserved fields
/// (`id`/`token`/`op`/`callerAgentId`). Everything the MCP server spread into the request top level
/// (per the frozen wire protocol `{ id, token, op, callerAgentId, ...payload }`) is forwarded to the
/// frontend event verbatim. Any `callerAgentId` a malicious payload tries to smuggle is stripped
/// here — the authoritative one comes from the top-level field extracted separately.
fn build_control_payload(req: &Value) -> Value {
    let mut map = serde_json::Map::new();
    if let Some(obj) = req.as_object() {
        for (k, v) in obj {
            if CONTROL_RESERVED_FIELDS.contains(&k.as_str()) { continue; }
            map.insert(k.clone(), v.clone());
        }
    }
    Value::Object(map)
}

/// Resolve the AUTHORITATIVE caller id for one request, from the socket it arrived on.
///
/// - `Concierge` socket → always `CONCIERGE_CALLER_AGENT_ID`. Whatever the client put in
///   `callerAgentId` is discarded, so a compromised concierge MCP child cannot impersonate a build
///   agent any more than a build agent can impersonate the concierge.
/// - `Shared` socket → the client-supplied top-level `callerAgentId` (absent → `""`, which the
///   frontend's `callerMayAdminister` already fails closed on), EXCEPT that claiming the reserved
///   concierge id is an error. That rejection is the whole anti-spoofing property: the reserved id
///   exists on exactly one socket, and this process is the only thing that can mint it.
///
/// Pure, so the two branches are directly unit-testable without a socket or a Tauri app.
fn resolve_control_caller(req: &Value, caller: ControlCaller) -> Result<String, String> {
    match caller {
        ControlCaller::Concierge => Ok(CONCIERGE_CALLER_AGENT_ID.to_string()),
        ControlCaller::Shared => {
            let claimed = req.get("callerAgentId").and_then(|c| c.as_str()).unwrap_or("");
            if claimed == CONCIERGE_CALLER_AGENT_ID {
                return Err(format!(
                    "callerAgentId {CONCIERGE_CALLER_AGENT_ID} is reserved for the concierge control socket"
                ));
            }
            Ok(claimed.to_string())
        }
    }
}

/// Pure request handler for the control bridge: one request JSON line → one response JSON line.
/// Validates the token, checks the op against the allowlist, resolves `callerAgentId` from the
/// SOCKET (see `resolve_control_caller`) plus the `payload`, then round-trips through the frontend.
/// No socket IO, so it is directly unit-testable.
fn handle_control_request_line(
    line: &str,
    token: &str,
    caller: ControlCaller,
    app: &Option<AppHandle>,
    pending: &PendingMap,
) -> String {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({ "id": Value::Null, "ok": false, "error": format!("bad json: {e}") }).to_string(),
    };
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    if req.get("token").and_then(|t| t.as_str()) != Some(token) {
        return json!({ "id": id, "ok": false, "error": "unauthorized" }).to_string();
    }
    let op = match req.get("op").and_then(|o| o.as_str()) {
        Some(o) => o,
        None => return json!({ "id": id, "ok": false, "error": "missing op" }).to_string(),
    };
    if !CONTROL_OPS.contains(&op) {
        return json!({ "id": id, "ok": false, "error": "unknown op" }).to_string();
    }
    // Authoritative identity comes from the SOCKET (plus, on the shared socket only, the TOP-LEVEL
    // callerAgentId) — never from anything nested in payload, which build_control_payload strips.
    let caller_agent_id = match resolve_control_caller(&req, caller) {
        Ok(c) => c,
        Err(e) => return json!({ "id": id, "ok": false, "error": e }).to_string(),
    };
    let payload = build_control_payload(&req);
    handle_control_op(id, op, &caller_agent_id, payload, app, pending)
}

/// Emit the `control:request` event and block on the rendezvous until `control_respond` resolves it
/// (or ROUNDTRIP_TIMEOUT fires). Register the reqId BEFORE emitting so a fast frontend reply can't
/// race ahead of registration.
fn handle_control_op(
    id: Value,
    op: &str,
    caller_agent_id: &str,
    payload: Value,
    app: &Option<AppHandle>,
    pending: &PendingMap,
) -> String {
    let app = match app {
        Some(a) => a,
        None => return json!({ "id": id, "ok": false, "error": "no app handle" }).to_string(),
    };
    let req_id = match generate_token() {
        Ok(t) => t,
        Err(e) => return json!({ "id": id, "ok": false, "error": format!("reqId gen: {e}") }).to_string(),
    };
    // Owner = the calling agent, so a control-bridge teardown can release this agent's blocked ops
    // (mirrors the orchestrator's per-owner resolve; main added the owner-id param to register_pending).
    let rx = register_pending(pending, &req_id, caller_agent_id);
    let event = json!({
        "reqId": req_id,
        "op": op,
        "callerAgentId": caller_agent_id,
        "payload": payload,
    });
    if let Err(e) = app.emit("control:request", event) {
        resolve_pending(pending, &req_id, Value::Null); // clean up the entry we just registered
        return json!({ "id": id, "ok": false, "error": format!("emit failed: {e}") }).to_string();
    }
    match wait_pending(rx, pending, &req_id, ROUNDTRIP_TIMEOUT) {
        Some(val) => json!({ "id": id, "ok": true, "result": val }).to_string(),
        None => json!({ "id": id, "ok": false, "error": "frontend round-trip timeout" }).to_string(),
    }
}

/// Start (or return the cached) singleton app-level control bridge (Tauri command). Idempotent:
/// repeat calls return the SAME socket + token for the life of the app launch.
#[tauri::command]
pub fn start_control_bridge(
    app: AppHandle,
    manager: State<ControlBridgeManager>,
) -> Result<BridgeInfo, String> {
    let (sock, token) = start_control_bridge_at(Some(app.clone()), &manager)?;
    Ok(BridgeInfo { socket_path: sock.to_string_lossy().to_string(), token })
}

/// Start (or return the cached) singleton CONCIERGE control bridge (Tauri command). Idempotent,
/// exactly like `start_control_bridge`, but a distinct socket + token whose every request is
/// stamped `CONCIERGE_CALLER_AGENT_ID`. Hand these to the concierge's control-MCP child as
/// `SPARKLE_CONTROL_SOCKET`/`SPARKLE_CONTROL_TOKEN` — and to NOTHING else.
///
/// HOW STRONG THIS ACTUALLY IS (roborev 54164, finding 2 — read before relying on it).
/// The identity is unforgeable *given the socket*: the listener stamps the caller id server-side,
/// and the shared socket rejects anything merely claiming that id. What is NOT unforgeable is
/// possession of the token, so the honest claim is "concierge authority requires a secret that is
/// not casually visible", NOT "concierge authority cannot be obtained".
///
/// Specifically: `concierge::write_concierge_mcp_config` deliberately does NOT repeat the shared
/// bridge's argv pattern — the token goes into a 0600 file passed as `--mcp-config <path>`, never
/// inline JSON on the command line, so it is not exposed via `ps aux` (the original finding's
/// concrete attack). But 0600 stops other *users*, not other processes of the SAME user, and the
/// spawned child's environment is readable to them as well. Since "a worker with shell access" is
/// exactly the adversary this design names, that residual exposure is real.
///
/// Closing it needs peer verification at accept time — `LOCAL_PEERPID` / `SO_PEERCRED` matched
/// against the pid `concierge.rs` spawned. Until that lands, do not describe this as a hard
/// boundary in docs, review, or user-facing copy.
#[tauri::command]
pub fn start_concierge_control_bridge(
    app: AppHandle,
    manager: State<ControlBridgeManager>,
) -> Result<BridgeInfo, String> {
    let (sock, token) = start_concierge_control_bridge_at(Some(app.clone()), &manager)?;
    Ok(BridgeInfo { socket_path: sock.to_string_lossy().to_string(), token })
}

/// Stop BOTH control bridges — shared and concierge (Tauri command).
#[tauri::command]
pub fn stop_control_bridge(manager: State<ControlBridgeManager>) -> Result<(), String> {
    stop_control_bridge_inner(&manager);
    Ok(())
}

/// Deliver a frontend response back to the control op blocking on `req_id` (Tauri command). Called
/// by the frontend after handling a `control:request` event.
#[tauri::command]
pub fn control_respond(
    manager: State<ControlBridgeManager>,
    req_id: String,
    result: Value,
) -> Result<(), String> {
    resolve_pending(&manager.pending, &req_id, result);
    Ok(())
}

/// Resolve the node binary + the bundled `mcp-control-server.js` (Tauri command). Mirrors
/// `orchestrator_mcp_paths` but for the sparkle-control server bundle.
#[tauri::command]
pub fn control_mcp_paths(app: AppHandle) -> Result<McpPaths, String> {
    let node_path = crate::preflight::resolve_node_path_cached()
        .ok_or_else(|| "node not found (install Node.js; needed to run sparkle-control)".to_string())?;
    let server = app
        .path()
        .resolve(
            "resources/mcp-control-server.js",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("control server.js missing: {e}"))?;
    if !server.exists() {
        return Err(format!(
            "control server.js not bundled at {} (run apps/desktop build to copy it)",
            server.display()
        ));
    }
    Ok(McpPaths {
        node_path,
        server_path: server.to_string_lossy().to_string(),
    })
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

    // FIX 2 + sparkle-i95d — stale-handle rebind: if a handle's accept loop has died (alive=false), a
    // subsequent start_bridge_at for the same id must rebind and bring the socket back up. The token
    // is now REUSED from the persisted registry (NOT rotated): a dead-loop rebind must stay transparent
    // to an MCP client whose frozen env still holds the original token, exactly as a boot reconcile is.
    #[test]
    fn stale_dead_handle_is_rebound_with_stable_token() {
        let app_data = short_unique_dir("stale");
        let mgr = BridgeManager::default();
        let (sock1, token1) = start_bridge_at(None, &mgr, &app_data, "p", "stale-agent", "L1").unwrap();

        // Reach into the manager and flip alive to false — simulating a fatal accept-loop exit.
        {
            let map = mgr.bridges.lock().unwrap();
            let h = map.get("stale-agent").expect("handle must exist after start");
            h.alive.store(false, Ordering::SeqCst);
        }

        // A second call for the same id must detect the dead handle, tear it down, and rebind.
        let (sock2, token2) = start_bridge_at(None, &mgr, &app_data, "p", "stale-agent", "L2").unwrap();
        assert_eq!(sock1, sock2, "rebind reuses the deterministic socket path");
        assert_eq!(token1, token2, "rebind must REUSE the persisted token, not rotate it (sparkle-i95d)");
        // The rebound socket is actually live again.
        assert!(UnixStream::connect(&sock2).is_ok(), "rebound socket must accept connections");

        stop_bridge(&mgr, "stale-agent", None);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // sparkle-i95d — token stability across a simulated APP RESTART: a fresh BridgeManager (the
    // in-memory map is gone, as after a process restart) binding the same agent against the same
    // app_data must REUSE the persisted token, so a still-running MCP client's frozen env keeps
    // validating once the socket is rebound.
    #[test]
    fn token_is_stable_across_process_restart() {
        let app_data = short_unique_dir("i95d-stable");
        // First "process": bind, capture the token, then drop the manager entirely.
        let token1 = {
            let mgr1 = BridgeManager::default();
            let (_sock, token) = start_bridge_at(None, &mgr1, &app_data, "proj", "restart-agent", "L1").unwrap();
            // Simulate the process going away without a graceful stop: forget the in-memory handle
            // (and its listener) but LEAVE the persisted registry on disk.
            stop_bridge(&mgr1, "restart-agent", None);
            token
        };
        // Second "process": a brand-new manager (empty in-memory map) binds the same agent.
        let mgr2 = BridgeManager::default();
        let (sock2, token2) = start_bridge_at(None, &mgr2, &app_data, "proj", "restart-agent", "L2").unwrap();
        assert_eq!(token1, token2, "token must survive a process restart (reused from the registry)");
        assert!(UnixStream::connect(&sock2).is_ok(), "rebound socket must be live");
        stop_bridge(&mgr2, "restart-agent", None);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // sparkle-i95d — boot reconcile: after a restart the host must rebind EVERY persisted agent's
    // socket up front (not lazily on pane remount). reconcile_bridges_at, given only the on-disk
    // registry and a fresh manager, brings each socket back live with its stable token.
    #[test]
    fn reconcile_rebinds_persisted_sockets_at_boot() {
        let app_data = short_unique_dir("i95d-recon");
        // Seed two agents' registry entries via a first "process", then drop that manager.
        let (tok_a, tok_b) = {
            let mgr = BridgeManager::default();
            let (_sa, ta) = start_bridge_at(None, &mgr, &app_data, "proj", "recon-a", "L1").unwrap();
            let (_sb, tb) = start_bridge_at(None, &mgr, &app_data, "proj", "recon-b", "L1").unwrap();
            // Tear down the live listeners (sockets removed) but keep the persisted registry.
            stop_bridge(&mgr, "recon-a", None);
            stop_bridge(&mgr, "recon-b", None);
            (ta, tb)
        };
        // Sockets are down now.
        let sock_a = bridge_socket_path(&app_data, "proj", "recon-a");
        let sock_b = bridge_socket_path(&app_data, "proj", "recon-b");
        assert!(UnixStream::connect(&sock_a).is_err(), "socket A down before reconcile");
        assert!(UnixStream::connect(&sock_b).is_err(), "socket B down before reconcile");

        // Boot reconcile with a brand-new manager rebinds both from the registry alone.
        let mgr2 = BridgeManager::default();
        let n = reconcile_bridges_at(None, &mgr2, &app_data);
        assert_eq!(n, 2, "both persisted agents rebound");
        assert!(UnixStream::connect(&sock_a).is_ok(), "socket A live after reconcile");
        assert!(UnixStream::connect(&sock_b).is_ok(), "socket B live after reconcile");
        // Tokens preserved through the reconcile.
        assert_eq!(persisted_bridge_token(&app_data, "recon-a").as_deref(), Some(tok_a.as_str()));
        assert_eq!(persisted_bridge_token(&app_data, "recon-b").as_deref(), Some(tok_b.as_str()));

        stop_bridge(&mgr2, "recon-a", None);
        stop_bridge(&mgr2, "recon-b", None);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // sparkle-i95d — a REAL teardown (stop_orchestration_bridge's owner-matched stop) forgets the
    // persisted entry so a closed agent is NOT rebound at the next boot; a stale-token no-op stop
    // must NOT forget it (the reopen reuses the same token). Exercised at the helper level.
    #[test]
    fn real_stop_forgets_persisted_entry_reconcile_skips_it() {
        let app_data = short_unique_dir("i95d-forget");
        let mgr = BridgeManager::default();
        let _ = start_bridge_at(None, &mgr, &app_data, "proj", "gone-agent", "L1").unwrap();
        assert!(persisted_bridge_token(&app_data, "gone-agent").is_some(), "persisted after start");

        // A stale-token stop is a no-op: entry must remain (the close-reopen race).
        assert!(!stop_bridge(&mgr, "gone-agent", Some("WRONG")), "stale-token stop is a no-op");
        // (entry still present because the command only forgets on a torn-down stop)
        assert!(persisted_bridge_token(&app_data, "gone-agent").is_some(), "stale no-op keeps the entry");

        // A real (owner) stop tears down; mirror the command's cleanup and forget the entry.
        assert!(stop_bridge(&mgr, "gone-agent", Some("L1")), "owner stop tears down");
        remove_persisted_bridge(&app_data, "gone-agent");
        assert!(persisted_bridge_token(&app_data, "gone-agent").is_none(), "forgotten after real teardown");

        // Boot reconcile must now rebind nothing.
        let mgr2 = BridgeManager::default();
        assert_eq!(reconcile_bridges_at(None, &mgr2, &app_data), 0, "closed agent not rebound at boot");
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // sparkle-i95d — directly cover the torn→forget conditional that stop_orchestration_bridge runs
    // (the command itself needs a Tauri runtime, so the wiring is exercised via the extracted helper).
    #[test]
    fn forget_persisted_if_torn_only_removes_on_real_teardown() {
        let app_data = short_unique_dir("i95d-torn");
        let mgr = BridgeManager::default();
        let _ = start_bridge_at(None, &mgr, &app_data, "proj", "torn-agent", "L1").unwrap();
        assert!(persisted_bridge_token(&app_data, "torn-agent").is_some(), "persisted after start");

        // torn=false (the stale-token no-op stop path) must KEEP the entry.
        forget_persisted_if_torn(&app_data, "torn-agent", false);
        assert!(persisted_bridge_token(&app_data, "torn-agent").is_some(), "no-op stop keeps the entry");

        // torn=true (a real owner-matched teardown) must FORGET it.
        forget_persisted_if_torn(&app_data, "torn-agent", true);
        assert!(persisted_bridge_token(&app_data, "torn-agent").is_none(), "real teardown forgets the entry");

        stop_bridge(&mgr, "torn-agent", None);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // sparkle-i95d — the token file must never be world-readable, even briefly: it's created 0600 and
    // written atomically (temp + rename), so at no point is the plaintext-token registry mode 0644.
    #[test]
    fn registry_file_is_0600() {
        let app_data = short_unique_dir("i95d-perm");
        let mgr = BridgeManager::default();
        let _ = start_bridge_at(None, &mgr, &app_data, "proj", "perm-agent", "L1").unwrap();
        let mode = std::fs::metadata(bridge_registry_path(&app_data)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "registry (plaintext tokens) must be owner-only");
        stop_bridge(&mgr, "perm-agent", None);
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

    // ---- sparkle-control (singleton app-level) bridge ----

    #[test]
    fn control_socket_path_is_short_and_temp_based() {
        let p = control_socket_path(ControlCaller::Shared, "deadbeefdeadbeef");
        assert_eq!(p, std::env::temp_dir().join("sparkle-ctrl-deadbeefdeadbeef.sock"));
        assert!(p.to_string_lossy().len() < 104, "control socket path must fit macOS sun_path");
        // The concierge socket is a DIFFERENT path — same length class, so it fits sun_path too.
        let c = control_socket_path(ControlCaller::Concierge, "deadbeefdeadbeef");
        assert_eq!(c, std::env::temp_dir().join("sparkle-conc-deadbeefdeadbeef.sock"));
        assert_ne!(p, c, "the two control sockets must never share a path");
        assert!(c.to_string_lossy().len() < 104, "concierge socket path must fit macOS sun_path");
    }

    #[test]
    fn control_rejects_bad_token() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let resp = handle_control_request_line(
            r#"{"id":"1","token":"WRONG","op":"get_state","callerAgentId":"a1"}"#,
            "RIGHT", ControlCaller::Shared, &None, &pending,
        );
        let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["id"], "1");
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "unauthorized");
    }

    #[test]
    fn control_missing_and_unknown_op() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let missing: serde_json::Value = serde_json::from_str(
            &handle_control_request_line(r#"{"id":"2","token":"T"}"#, "T", ControlCaller::Shared, &None, &pending),
        ).unwrap();
        assert_eq!(missing["error"], "missing op");
        let unknown: serde_json::Value = serde_json::from_str(
            &handle_control_request_line(
                r#"{"id":"3","token":"T","op":"rm_rf"}"#, "T", ControlCaller::Shared, &None, &pending,
            ),
        ).unwrap();
        assert_eq!(unknown["error"], "unknown op");
        // No pending entries were registered by rejected requests.
        assert!(pending.lock().unwrap().is_empty(), "rejected requests must not register pending entries");
    }

    #[test]
    fn control_all_ops_are_allowlisted() {
        for op in [
            // Phase 1.
            "get_state", "rename_agent", "set_agent_activity", "set_theme", "get_config", "set_config",
            // Phase 3 breadth ops.
            "pin_agent", "unpin_agent", "set_agent_model", "set_agent_ordering", "set_zoom", "navigate",
            // Phase 4: the concierge tool surface (one generic op; domain/op ride in the payload).
            "concierge_tool",
        ] {
            assert!(CONTROL_OPS.contains(&op), "{op} must be in the control allowlist");
        }
        assert_eq!(
            CONTROL_OPS.len(),
            13,
            "exactly the frozen Phase-1 + Phase-3 + Phase-4 control ops"
        );
    }

    #[test]
    fn control_payload_strips_reserved_and_spoofed_fields() {
        // A malicious request nests a callerAgentId inside the spread payload AND at top level.
        let req: serde_json::Value = serde_json::from_str(
            r#"{"id":"1","token":"T","op":"rename_agent","callerAgentId":"real","name":"Neo","targetAgentId":"t9"}"#,
        ).unwrap();
        let payload = build_control_payload(&req);
        // Reserved fields never leak into payload.
        assert!(payload.get("id").is_none());
        assert!(payload.get("token").is_none());
        assert!(payload.get("op").is_none());
        assert!(payload.get("callerAgentId").is_none(), "callerAgentId must not ride inside payload");
        // Op data passes through.
        assert_eq!(payload["name"], "Neo");
        assert_eq!(payload["targetAgentId"], "t9");
    }

    #[test]
    fn control_op_without_app_handle_errors() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let resp = handle_control_request_line(
            r#"{"id":"7","token":"T","op":"set_theme","callerAgentId":"a1","theme":"dark"}"#,
            "T", ControlCaller::Shared, &None, &pending,
        );
        let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["id"], "7");
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "no app handle");
        // Reached the round-trip path but bailed before registering a pending entry.
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn start_control_bridge_at_is_idempotent_singleton() {
        let mgr = ControlBridgeManager::default();
        let (sock1, token1) = start_control_bridge_at(None, &mgr).unwrap();
        let (sock2, token2) = start_control_bridge_at(None, &mgr).unwrap();
        assert_eq!(sock1, sock2, "singleton: same socket path across calls");
        assert_eq!(token1, token2, "singleton: same token across calls");
        // 0600 perms on the socket file.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&sock1).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "control socket must be owner-only");
        }
        stop_control_bridge_inner(&mgr);
        assert!(!sock1.exists(), "socket file removed on stop");
    }

    #[test]
    fn control_listener_authed_and_bad_token_over_socket() {
        let mgr = ControlBridgeManager::default();
        let (sock, token) = start_control_bridge_at(None, &mgr).unwrap();

        // Bad token → unauthorized (no app handle needed, fails before the round-trip).
        let mut s = UnixStream::connect(&sock).unwrap();
        writeln!(s, r#"{{"id":"1","token":"NOPE","op":"get_state","callerAgentId":"a"}}"#).unwrap();
        let mut r = BufReader::new(s);
        let mut resp = String::new();
        r.read_line(&mut resp).unwrap();
        let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "unauthorized");

        // Authed but None app handle in tests → "no app handle" (proves auth + dispatch path work).
        let mut s2 = UnixStream::connect(&sock).unwrap();
        let req = format!(r#"{{"id":"2","token":"{token}","op":"get_state","callerAgentId":"a"}}"#);
        writeln!(s2, "{req}").unwrap();
        let mut r2 = BufReader::new(s2);
        let mut resp2 = String::new();
        r2.read_line(&mut resp2).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&resp2).unwrap();
        assert_eq!(v2["ok"], false);
        assert_eq!(v2["error"], "no app handle");

        stop_control_bridge_inner(&mgr);
        assert!(UnixStream::connect(&sock).is_err(), "must not connect after stop");
    }

    #[test]
    fn control_stale_dead_handle_is_rebound() {
        let mgr = ControlBridgeManager::default();
        let (_sock1, token1) = start_control_bridge_at(None, &mgr).unwrap();
        {
            let guard = mgr.inner.lock().unwrap();
            let h = guard.as_ref().expect("handle must exist after start");
            h.alive.store(false, Ordering::SeqCst); // simulate a fatal accept-loop exit
        }
        let (_sock2, token2) = start_control_bridge_at(None, &mgr).unwrap();
        assert_ne!(token1, token2, "a fresh rebind must produce a new token, not the stale one");
        stop_control_bridge_inner(&mgr);
    }

    // ---- concierge caller identity (bead sparkle-9a8j, design A7.3) ----

    #[test]
    fn concierge_socket_stamps_the_reserved_caller_id_whatever_the_client_sent() {
        // A client on the concierge socket claiming to be a build agent...
        let impersonating: Value = serde_json::from_str(
            r#"{"id":"1","token":"T","op":"set_theme","callerAgentId":"some-build-agent-uuid","theme":"dark"}"#,
        ).unwrap();
        assert_eq!(
            resolve_control_caller(&impersonating, ControlCaller::Concierge).unwrap(),
            CONCIERGE_CALLER_AGENT_ID,
            "the concierge socket must OVERWRITE a claimed id, not merge with it",
        );
        // ...and one sending no id at all (mcp-control sends "" when SPARKLE_AGENT_ID is unset).
        let anonymous: Value = serde_json::from_str(r#"{"id":"2","token":"T","op":"get_state"}"#).unwrap();
        assert_eq!(
            resolve_control_caller(&anonymous, ControlCaller::Concierge).unwrap(),
            CONCIERGE_CALLER_AGENT_ID,
            "an absent callerAgentId on the concierge socket still resolves to the reserved id",
        );
        let empty: Value =
            serde_json::from_str(r#"{"id":"3","token":"T","op":"get_state","callerAgentId":""}"#).unwrap();
        assert_eq!(
            resolve_control_caller(&empty, ControlCaller::Concierge).unwrap(),
            CONCIERGE_CALLER_AGENT_ID,
        );
    }

    #[test]
    fn shared_socket_rejects_a_request_claiming_the_reserved_concierge_id() {
        // The pure resolver refuses it...
        let spoof: Value = serde_json::from_str(&format!(
            r#"{{"id":"1","token":"T","op":"set_theme","callerAgentId":"{CONCIERGE_CALLER_AGENT_ID}","theme":"dark"}}"#
        )).unwrap();
        let err = resolve_control_caller(&spoof, ControlCaller::Shared)
            .expect_err("the reserved id must not be claimable on the shared socket");
        assert!(err.contains(CONCIERGE_CALLER_AGENT_ID) && err.contains("reserved"), "got {err}");

        // ...and so does the full request path, BEFORE any round-trip is registered. Note this is
        // a token-AUTHORIZED request: holding the shared token still does not buy concierge
        // authority, which is the point of minting identity from the socket.
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let line = format!(
            r#"{{"id":"9","token":"T","op":"set_theme","callerAgentId":"{CONCIERGE_CALLER_AGENT_ID}","theme":"dark"}}"#
        );
        let v: Value = serde_json::from_str(&handle_control_request_line(
            &line, "T", ControlCaller::Shared, &None, &pending,
        )).unwrap();
        assert_eq!(v["id"], "9");
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("reserved"), "got {v}");
        // Crucially NOT the "no app handle" error a request that got past identity would produce.
        assert_ne!(v["error"], "no app handle", "must be refused at identity, not later");
        assert!(pending.lock().unwrap().is_empty(), "a spoofed request must not register a pending entry");
    }

    #[test]
    fn shared_socket_still_passes_an_ordinary_caller_through_unchanged() {
        // The reserved-id rejection must not disturb every other caller.
        let ordinary: Value = serde_json::from_str(
            r#"{"id":"1","token":"T","op":"get_state","callerAgentId":"e4a0cd29-525c-4ce7-8214-8e0411385b5e"}"#,
        ).unwrap();
        assert_eq!(
            resolve_control_caller(&ordinary, ControlCaller::Shared).unwrap(),
            "e4a0cd29-525c-4ce7-8214-8e0411385b5e",
        );
        // An unidentified caller stays "" — the frontend's callerMayAdminister fails closed on it.
        let anonymous: Value = serde_json::from_str(r#"{"id":"2","token":"T","op":"get_state"}"#).unwrap();
        assert_eq!(resolve_control_caller(&anonymous, ControlCaller::Shared).unwrap(), "");
    }

    #[test]
    fn concierge_socket_strips_a_payload_nested_caller_id_too() {
        // Defense in depth: identity is overwritten from the socket AND the reserved-field strip
        // keeps a smuggled copy out of the payload the frontend reads.
        let req: Value = serde_json::from_str(
            r#"{"id":"1","token":"T","op":"rename_agent","callerAgentId":"evil","name":"Neo"}"#,
        ).unwrap();
        assert_eq!(resolve_control_caller(&req, ControlCaller::Concierge).unwrap(), CONCIERGE_CALLER_AGENT_ID);
        let payload = build_control_payload(&req);
        assert!(payload.get("callerAgentId").is_none(), "callerAgentId must not ride inside payload");
        assert_eq!(payload["name"], "Neo");
    }

    #[test]
    fn concierge_bridge_is_a_separate_singleton_socket_and_token() {
        let mgr = ControlBridgeManager::default();
        let (shared_sock, shared_token) = start_control_bridge_at(None, &mgr).unwrap();
        let (conc_sock, conc_token) = start_concierge_control_bridge_at(None, &mgr).unwrap();
        assert_ne!(shared_sock, conc_sock, "the concierge must not share the app-level socket");
        assert_ne!(shared_token, conc_token, "the concierge token is minted independently");
        assert!(
            conc_sock.file_name().unwrap().to_string_lossy().starts_with("sparkle-conc-"),
            "concierge socket is the sparkle-conc-<hex> path: {conc_sock:?}",
        );
        // Idempotent singleton, same as the shared one.
        let (again_sock, again_token) = start_concierge_control_bridge_at(None, &mgr).unwrap();
        assert_eq!((conc_sock.clone(), conc_token.clone()), (again_sock, again_token));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&conc_sock).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "concierge socket must be owner-only");
        }
        // Its token is NOT interchangeable with the shared one, in either direction.
        let mut s = UnixStream::connect(&conc_sock).unwrap();
        writeln!(s, r#"{{"id":"1","token":"{shared_token}","op":"get_state"}}"#).unwrap();
        let mut r = BufReader::new(s);
        let mut resp = String::new();
        r.read_line(&mut resp).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"], "unauthorized", "the shared token must not open the concierge socket");

        // With its OWN token it authenticates and reaches the round-trip (no app handle in tests).
        let mut s2 = UnixStream::connect(&conc_sock).unwrap();
        writeln!(s2, r#"{{"id":"2","token":"{conc_token}","op":"get_state"}}"#).unwrap();
        let mut r2 = BufReader::new(s2);
        let mut resp2 = String::new();
        r2.read_line(&mut resp2).unwrap();
        let v2: Value = serde_json::from_str(&resp2).unwrap();
        assert_eq!(v2["error"], "no app handle", "authed on its own token: {v2}");

        // Stopping the control bridge takes BOTH listeners down.
        stop_control_bridge_inner(&mgr);
        assert!(!conc_sock.exists(), "concierge socket file removed on stop");
        assert!(!shared_sock.exists(), "shared socket file removed on stop");
        assert!(UnixStream::connect(&conc_sock).is_err(), "must not connect after stop");
    }

    #[test]
    fn concierge_tool_survives_the_transport_not_just_the_frontend() {
        // ROBOREV 54241 (High). The whole concierge tool spine is reachable only if `concierge_tool`
        // is in CONTROL_OPS: `handle_control_request_line` rejects anything outside it with
        // "unknown op" BEFORE the frontend event is ever emitted. Every other test of that spine
        // bypasses this transport — the desktop tests fire the `control:request` payload directly
        // and the mcp-control tests mock `Bridge` — so all of them stay green while every real
        // sparkle_lifecycle/_terminal/_workflow/_workspace call dies at the socket.
        //
        // This drives the real request path. "no app handle" means it got PAST the allowlist and
        // reached the frontend round-trip (there is no app in tests); "unknown op" would mean the
        // spine is dead in production.
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let line = r#"{"id":"1","token":"T","op":"concierge_tool","domain":"workspace","op2":"x"}"#;
        let v: Value = serde_json::from_str(&handle_control_request_line(
            line, "T", ControlCaller::Concierge, &None, &pending,
        )).unwrap();
        assert_ne!(
            v["error"], "unknown op",
            "concierge_tool must be in CONTROL_OPS or the entire tool spine is unreachable: {v}"
        );
        assert_eq!(v["error"], "no app handle", "expected to reach the round-trip: {v}");
    }

    #[test]
    fn concierge_listener_actually_threads_its_caller_kind_end_to_end() {
        // ROBOREV 54164, FINDING 1 — the mutant this kills.
        //
        // Concierge identity is "structural" only because the LISTENER's `caller` value is
        // threaded serve_control_conn -> handle_control_request_line -> resolve_control_caller.
        // Every other test either drives the pure resolver with a hand-passed caller, or drives
        // the concierge socket with anonymous requests. Both stay green if someone hardcodes
        // `ControlCaller::Shared` in the concierge accept loop: an anonymous request would then
        // resolve to "" and still end at "no app handle", silently downgrading the concierge to
        // an unprivileged empty id — the exact failure the whole design exists to prevent.
        //
        // The discriminator is a request carrying a callerAgentId ON THE CONCIERGE SOCKET:
        //   - correctly threaded (Concierge) -> id is overwritten server-side -> "no app handle"
        //   - mutated to Shared              -> the reserved-id claim is REJECTED -> "…reserved…"
        // so the two kinds produce different errors for the same bytes.
        let mgr = ControlBridgeManager::default();
        let (_shared_sock, _shared_token) = start_control_bridge_at(None, &mgr).unwrap();
        let (conc_sock, conc_token) = start_concierge_control_bridge_at(None, &mgr).unwrap();

        // (a) A request that CLAIMS the reserved id. On the concierge socket the claim is simply
        //     overwritten (it is already the truth), so it must sail past identity.
        let mut s = UnixStream::connect(&conc_sock).unwrap();
        writeln!(
            s,
            r#"{{"id":"1","token":"{conc_token}","op":"set_theme","callerAgentId":"{CONCIERGE_CALLER_AGENT_ID}","theme":"dark"}}"#
        ).unwrap();
        let mut r = BufReader::new(s);
        let mut resp = String::new();
        r.read_line(&mut resp).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(
            v["error"], "no app handle",
            "on the CONCIERGE socket the reserved id is the stamped truth, not a spoof: {v}"
        );
        assert!(
            !v["error"].as_str().unwrap_or_default().contains("reserved"),
            "a 'reserved' error here means the accept loop passed ControlCaller::Shared: {v}"
        );

        // (b) A FOREIGN id on the same socket must also be overwritten, not honoured — otherwise
        //     the concierge could impersonate a specific build agent by asking nicely.
        let mut s2 = UnixStream::connect(&conc_sock).unwrap();
        writeln!(
            s2,
            r#"{{"id":"2","token":"{conc_token}","op":"set_theme","callerAgentId":"e4a0cd29-525c-4ce7-8214-8e0411385b5e","theme":"dark"}}"#
        ).unwrap();
        let mut r2 = BufReader::new(s2);
        let mut resp2 = String::new();
        r2.read_line(&mut resp2).unwrap();
        let v2: Value = serde_json::from_str(&resp2).unwrap();
        assert_eq!(v2["error"], "no app handle", "a foreign claim is overwritten, not rejected: {v2}");

        stop_control_bridge_inner(&mgr);
    }

    #[test]
    fn concierge_caller_id_is_mirrored_in_typescript() {
        // The reserved id is defined ONCE here and mirrored in the frontend gate. A drift between
        // the two is silent and total: Rust would stamp an id `callerMayAdminister` does not admit,
        // so every privileged concierge op would be refused with no error pointing at the cause.
        let ts = std::fs::read_to_string("../src/services/controlListener.ts")
            .expect("controlListener.ts must be readable from src-tauri (cargo runs at crate root)");
        let literal = format!(r#""{CONCIERGE_CALLER_AGENT_ID}""#);
        assert!(
            ts.contains(&literal),
            "controlListener.ts must define CONCIERGE_CALLER_AGENT_ID = {literal}",
        );
    }
}
