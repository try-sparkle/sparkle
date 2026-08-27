// Frontend bindings for the dock-badge + notification backend (src-tauri/src/attention.rs).
// Every call is a no-op outside Tauri (tests, SSR) so the UI code can call them unconditionally.
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RosterPayload } from "./relayClient";
import type { Roster } from "./rosterTypes";
import type { StatusBand } from "../engine/buildSections";
import { noteAiProviderFailure, noteAiServiceFailure } from "./anthropic";
import { oneshotFailoverConfigDir } from "./accountSelection";

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
 *  empty) — never throws — so the caller falls back to the generic body.
 *
 *  `project` is diagnostic only now — it used to attribute a credit debit, and this call spends the
 *  user's own Claude Code subscription rather than Sparkle credits.
 *
 *  Reports AI health both ways (see anthropic.ts). It is a high-frequency BACKGROUND caller, which
 *  makes it the likeliest wrapper to be the one that clears a stale banner after the user installs
 *  or signs into the CLI — and, if a session's only AI traffic is attention summaries, the only one
 *  that would ever light it. */
export async function summarizeAttention(
  screen: string,
  project?: string,
): Promise<string | null> {
  if (!hasTauri) return null;
  try {
    // Route off a walled default account to a healthy signed-in one when possible; undefined leaves
    // the ambient default and is dropped from the invoke. See
    // `accountSelection.oneshotFailoverConfigDir`.
    const configDir = await oneshotFailoverConfigDir();
    const summary = await invoke<string>("summarize_attention", { screen, project, configDir });
    // NO healthy-report. summarize_attention is `cacheable: true`, and claude_oneshot serves a
    // cache hit before acquiring a permit or spawning anything — and its own doc says the point is
    // that a re-raised identical prompt must not re-summarize, so a persistent unanswered prompt
    // hits the cache on EVERY tick. Reporting healthy from that would zero the failure run and let a
    // wedged or signed-out CLI hide behind a non-dismissible banner saying everything is fine.
    return typeof summary === "string" ? summary : null;
  } catch (e) {
    noteAiProviderFailure(e);
    noteAiServiceFailure(e);
    console.debug("summarize_attention failed", e);
    return null;
  }
}

export interface FocusAgentPayload {
  projectId: string;
  agentId: string;
  /** Optional: after focusing, scroll the agent's terminal to this promptHistory entry. */
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

/** Which status band the helper island's chiclet was clicked for. Was "p0" | "p1" until the
 *  P0/P1 vocabulary was retired; it is now the app-wide band (engine/buildSections). */
export interface FocusTierPayload {
  band: StatusBand;
}

/**
 * "Show me what needs me" from the floating helper island — a band, not a specific agent.
 *
 * Its OWN event rather than a variant of focus-agent, for the same reason select-project is
 * separate (see the note below): focus-agent mounts an agent and spawns its PTY, which is far too
 * much to do for what is really just "raise the window and put the urgent work in front of me".
 * No-op outside Tauri.
 */
export function emitFocusTier(p: FocusTierPayload): void {
  if (!hasTauri) return;
  void emit("attention://focus-tier", p).catch((e) =>
    console.debug("emit focus-tier failed", e),
  );
}

/** Subscribe to a helper-island chiclet click. Returns an unlisten fn (no-op outside Tauri). */
export function onFocusTier(cb: (p: FocusTierPayload) => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(() => {});
  return listen<FocusTierPayload>("attention://focus-tier", (e) => cb(e.payload));
}

export interface SelectProjectPayload {
  projectId: string;
}

/**
 * "Show me this project" from another webview — e.g. the capture window.
 *
 * SEPARATE from focus-agent on purpose (roborev 46249-H1/M2). Raising the app window used to be a
 * side effect of emitFocusAgent, which needs an agent to aim at: a project with no agents emitted
 * nothing at all, and a project WITH
 * agents got an invented target — mounting/resuming a PTY at real token cost and yanking the user
 * out of Plan/Sparkle for a click that only asked to see a project. (The dead click was the old
 * tray's Open on a freshly added folder; the tray is gone, the hazard is not.) This event carries
 * no agent,
 * so it can do neither. Reserve focus-agent for genuine agent reveals.
 */
export function onSelectProject(cb: (p: SelectProjectPayload) => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(() => {});
  return listen<SelectProjectPayload>("attention://select-project", (e) => cb(e.payload));
}

/** Broadcast "select this project's tab and raise the app window". No-op outside Tauri. */
export function emitSelectProject(p: SelectProjectPayload): void {
  if (!hasTauri) return;
  void emit("attention://select-project", p).catch((e) =>
    console.debug("emit select-project failed", e),
  );
}

/** Publish THIS window's open-project roster slice to the Rust aggregator, which merges every
 *  window's slice into the cross-window fleet the concierge reasons over. No-op outside Tauri. */
export function publishWindowRoster(label: string, projects: RosterPayload["projects"]): void {
  if (!hasTauri) return;
  void invoke("publish_window_roster", { label, projects }).catch((e) =>
    console.debug("publish_window_roster failed", e),
  );
}

/** Drop this window's contribution to the roster (on window close). No-op outside Tauri. */
export function clearWindowRoster(label: string): void {
  if (!hasTauri) return;
  void invoke("clear_window_roster", { label }).catch((e) =>
    console.debug("clear_window_roster failed", e),
  );
}

/** Fetch the current merged roster from the Rust aggregator. Resolves null outside Tauri. */
export function getRoster(): Promise<Roster | null> {
  if (!hasTauri) return Promise.resolve(null);
  return invoke<Roster>("get_roster").catch(() => null);
}

/** Subscribe to roster-changed pushes from the Rust aggregator. Returns a no-op unlisten outside Tauri. */
export function onRosterChanged(cb: (r: Roster) => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(() => {});
  return listen<Roster>("roster://changed", (e) => cb(e.payload));
}

/** Fully exit the app (the helper island's right-click "Quit Sparkle"). Closing the main window
 *  only hides it; this is the real quit. No-op outside Tauri. */
export function quitApp(): void {
  if (!hasTauri) return;
  void invoke("quit_app").catch((e) => console.debug("quit_app failed", e));
}
