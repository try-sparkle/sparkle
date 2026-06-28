// Frontend bindings for the dock-badge + notification backend (src-tauri/src/attention.rs).
// Every call is a no-op outside Tauri (tests, SSR) so the UI code can call them unconditionally.
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

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

export interface FocusAgentPayload {
  projectId: string;
  agentId: string;
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
