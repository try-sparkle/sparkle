// Frontend bindings for the dock-badge + notification backend (src-tauri/src/attention.rs).
// Every call is a no-op outside Tauri (tests, SSR) so the UI code can call them unconditionally.
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RosterPayload } from "./relayClient";
import type { TrayRoster } from "../tray/trayRoster";

const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Report how many of THIS window's agents currently need attention. The backend sums across
 *  windows and paints the dock badge. Reporting 0 removes this window's contribution. */
export function reportAttentionCount(label: string, count: number): void {
  if (!hasTauri) return;
  void invoke("set_window_attention", { label, count }).catch((e) =>
    console.debug("set_window_attention failed", e),
  );
}

export interface AttentionNotice {
  projectId: string;
  agentId: string;
  title: string;
  body: string;
}

/** Fire a Notification Center banner for an agent that just started needing you. Clicking it
 *  emits the focus-agent event (see onFocusAgent). */
export function notifyAttention(n: AttentionNotice): void {
  if (!hasTauri) return;
  void invoke("notify_attention", {
    projectId: n.projectId,
    agentId: n.agentId,
    title: n.title,
    body: n.body,
  }).catch((e) => console.debug("notify_attention failed", e));
}

/** Ask the backend (Haiku 4.5) for a short, notification-friendly summary of WHAT an agent is
 *  asking, derived from the tail of its terminal `screen`. Used as the banner body for the
 *  waiting/approval "ask" cases. Returns null outside Tauri and on any failure (no key, network,
 *  empty) — never throws — so the caller falls back to the generic body. */
export async function summarizeAttention(screen: string): Promise<string | null> {
  if (!hasTauri) return null;
  try {
    const summary = await invoke<string>("summarize_attention", { screen });
    return typeof summary === "string" ? summary : null;
  } catch (e) {
    console.debug("summarize_attention failed", e);
    return null;
  }
}

export interface FocusAgentPayload {
  projectId: string;
  agentId: string;
  /** Optional: after focusing, scroll the agent's terminal to this promptHistory entry (tray breadcrumb). */
  promptId?: string;
}

/** Subscribe to a notification click. The backend broadcasts this to every window; the caller
 *  decides which window owns the agent. Returns an unlisten fn (no-op outside Tauri). */
export function onFocusAgent(cb: (p: FocusAgentPayload) => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(() => {});
  return listen<FocusAgentPayload>("attention://focus-agent", (e) => cb(e.payload));
}

/** Ask whichever window owns this agent's project to bring itself forward and select the agent —
 *  the same path a notification click takes, but driven from the UI (e.g. a history-search hit in
 *  a project this window doesn't own). Broadcasts to every window; the owning window handles it
 *  (and the main window adopts an orphaned project). No-op outside Tauri. */
export function emitFocusAgent(p: FocusAgentPayload): void {
  if (!hasTauri) return;
  void emit("attention://focus-agent", p).catch((e) =>
    console.debug("emit focus-agent failed", e),
  );
}

/** Publish THIS window's open-project roster slice to the Rust tray aggregator. The backend merges
 *  every window's slice, recomputes red/grey/green counts, and repaints the menu bar. No-op outside Tauri. */
export function publishWindowRoster(label: string, projects: RosterPayload["projects"]): void {
  if (!hasTauri) return;
  void invoke("publish_window_roster", { label, projects }).catch((e) =>
    console.debug("publish_window_roster failed", e),
  );
}

/** Drop this window's contribution to the tray roster (on window close). No-op outside Tauri. */
export function clearWindowRoster(label: string): void {
  if (!hasTauri) return;
  void invoke("clear_window_roster", { label }).catch((e) =>
    console.debug("clear_window_roster failed", e),
  );
}

/** Fetch the current merged tray roster from the Rust aggregator. Resolves null outside Tauri. */
export function getTrayRoster(): Promise<TrayRoster | null> {
  if (!hasTauri) return Promise.resolve(null);
  return invoke<TrayRoster>("get_tray_roster").catch(() => null);
}

/** Subscribe to roster-changed pushes from the Rust aggregator. Returns a no-op unlisten outside Tauri. */
export function onTrayRosterChanged(cb: (r: TrayRoster) => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(() => {});
  return listen<TrayRoster>("tray://roster-changed", (e) => cb(e.payload));
}

/** Send a new menu-bar icon image to Tauri as a base64-encoded PNG. No-op outside Tauri. */
export function setTrayImage(pngBase64: string): void {
  if (!hasTauri) return;
  void invoke("set_tray_image", { pngBase64 }).catch((e) => console.debug("set_tray_image failed", e));
}

/** Fully exit the app (the tray popover's "Quit Sparkle" button). Closing the main window only
 *  hides it behind the tray; this is the real quit. No-op outside Tauri. */
export function quitApp(): void {
  if (!hasTauri) return;
  void invoke("quit_app").catch((e) => console.debug("quit_app failed", e));
}
