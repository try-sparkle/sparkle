// Frontend bridge to the Rust reachability probe (src-tauri/src/connectivity.rs). We probe from
// Rust (ureq) rather than a webview fetch so we dodge CORS and get a true transport-level verdict.
import { invoke } from "@tauri-apps/api/core";

/** Ask the backend whether the network is actually reachable. Falls back to the browser's own
 *  view if the command is unavailable (e.g. the plain `vite` browser preview, no Tauri). */
export async function probeConnectivity(): Promise<boolean> {
  try {
    return await invoke<boolean>("probe_connectivity");
  } catch {
    return typeof navigator !== "undefined" ? navigator.onLine : true;
  }
}
