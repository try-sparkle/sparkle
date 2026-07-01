//! Windows stub for the orchestration bridge.
//!
//! The real bridge (`bridge.rs`) is a per-build-agent **Unix-domain socket** the build agent's
//! MCP server connects to (`std::os::unix::net`), so it only compiles on Unix. This stub mirrors
//! its public surface — `BridgeManager` plus the four `#[tauri::command]`s wired in `lib.rs` —
//! so the rest of the crate stays platform-agnostic. Every command reports the bridge as
//! unavailable on Windows.
//!
//! Phase-2 follow-up: re-implement the transport over a Windows named pipe or a localhost TCP
//! socket (Windows 10+ also supports `AF_UNIX`) and replace this stub. See the Windows port
//! design doc.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

/// Same name + `Default`/`Send`/`Sync`/`'static` shape as the Unix `BridgeManager`, so
/// `lib.rs`'s `.manage(bridge::BridgeManager::default())` is unchanged. Holds no state on
/// Windows because the bridge never starts.
#[derive(Default)]
pub struct BridgeManager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    socket_path: String,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPaths {
    node_path: String,
    server_path: String,
}

const UNSUPPORTED: &str =
    "the orchestration bridge is not yet supported on Windows (Phase-2 follow-up)";

#[tauri::command]
pub fn start_orchestration_bridge(
    _app: AppHandle,
    _manager: State<BridgeManager>,
    _project_id: String,
    _build_agent_id: String,
) -> Result<BridgeInfo, String> {
    Err(UNSUPPORTED.to_string())
}

#[tauri::command]
pub fn stop_orchestration_bridge(
    _manager: State<BridgeManager>,
    _build_agent_id: String,
) -> Result<(), String> {
    // Idempotent on Unix; a no-op here since nothing was ever started.
    Ok(())
}

#[tauri::command]
pub fn orchestrator_mcp_paths(_app: AppHandle) -> Result<McpPaths, String> {
    Err(UNSUPPORTED.to_string())
}

#[tauri::command]
pub fn orchestration_respond(
    _manager: State<BridgeManager>,
    _req_id: String,
    _result: Value,
) -> Result<(), String> {
    Err(UNSUPPORTED.to_string())
}
