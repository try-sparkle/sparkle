// Cross-window LIVE STATUS channel — the one piece crossWindowSync doesn't carry. Each window's
// agent status (runtimeStore.status) is per-window and never persisted/shared, so a window can't
// otherwise see that an agent in ANOTHER open window has gone red. This module mirrors the
// roster/registry patterns: a shared localStorage map every window can read, with each window
// writing ONLY its own label's entry (its red agents), broadcast via a Tauri event so other
// windows re-read. Reliable path is the Tauri `emit` (the browser `storage` event isn't reliably
// delivered across separate WKWebViews); we also write storage so dev/tests fan out via `storage`.
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AGENT_STATUS } from "@sparkle/ui";
import { isWindowOpen, defaultStore, WINDOW_REGISTRY_KEY, type KV } from "./windowRegistry";
import type { AgentTabStatus } from "../types";

export const WINDOW_STATUS_KEY = "sparkle-window-status";
export const STATUS_CHANGED_EVENT = "sparkle://status-changed";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** A red agent as published by its owning window (display name already resolved). */
export interface WindowRedAgent {
  id: string;
  name: string;
  status: AgentTabStatus;
}

/** One window's entry in the shared map: the project it shows + its currently-red agents. */
export interface WindowStatusEntry {
  projectId: string;
  projectName: string;
  agents: WindowRedAgent[];
}

export type WindowStatusMap = Record<string, WindowStatusEntry>;

/** A flattened red agent from some OTHER open window, ready for the sidebar section. */
export interface OtherWindowAgent {
  windowLabel: string;
  projectId: string;
  projectName: string;
  agentId: string;
  agentName: string;
  status: AgentTabStatus;
}

function readMap(store: KV): WindowStatusMap {
  try {
    const raw = store.getItem(WINDOW_STATUS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as WindowStatusMap) : {};
  } catch {
    return {};
  }
}

function writeMap(store: KV, map: WindowStatusMap): void {
  store.setItem(WINDOW_STATUS_KEY, JSON.stringify(map));
}

// The "needs your attention" (RED) statuses are exactly those whose AGENT_STATUS color is the brand
// red — waiting, approval, errored (packages/ui/tokens.ts). Deliberately NOT the narrower badge set
// (waiting|approval) used by useAttentionNotifications.isRelayRed: this feature surfaces the full
// red-color tier, errored included. The subtype is kept in sync with the runtime check below so the
// predicate narrows SOUNDLY on both branches.
export type RedStatus = "waiting" | "approval" | "errored";
const RED = AGENT_STATUS.errored.color;
export function isRedStatus(status: AgentTabStatus | undefined): status is RedStatus {
  return status != null && AGENT_STATUS[status]?.color === RED;
}

// Coalesce the broadcast so a burst of status ticks emits once (~250ms, like useRosterPublisher).
// The storage WRITE is synchronous (so a same-tick read sees it); only the cross-window emit is
// debounced. No-op outside Tauri.
let emitTimer: ReturnType<typeof setTimeout> | undefined;
function fire(): void {
  // Self-echo is harmless: the emitting window re-reads the blob it just wrote (idempotent). Wrap
  // in Promise.resolve so a non-promise emit (mocks/tests) doesn't crash the .catch.
  void Promise.resolve(emit(STATUS_CHANGED_EVENT)).catch((e) =>
    console.debug("status-changed emit failed", e),
  );
}
function scheduleEmit(): void {
  if (!inTauri()) return;
  if (emitTimer) clearTimeout(emitTimer);
  emitTimer = setTimeout(() => {
    emitTimer = undefined;
    fire();
  }, 250);
}
function emitNow(): void {
  if (emitTimer) {
    clearTimeout(emitTimer);
    emitTimer = undefined;
  }
  if (inTauri()) fire();
}

/** Write/overwrite THIS window's entry with its red agents (deleting it when there are none), then
 *  broadcast (debounced). Other windows re-read and recompute their cross-window section. */
export function publishWindowRedAgents(
  label: string,
  projectId: string,
  projectName: string,
  redAgents: WindowRedAgent[],
  store: KV = defaultStore(),
): void {
  const map = readMap(store);
  if (redAgents.length === 0) {
    if (!(label in map)) return; // nothing to change, skip the write + broadcast
    delete map[label];
  } else {
    map[label] = { projectId, projectName, agents: redAgents };
  }
  writeMap(store, map);
  scheduleEmit();
}

/** Remove THIS window's entry and broadcast immediately. Called on window unload, so we flush the
 *  emit rather than leaving it on a debounce timer the closing window may never run. */
export function clearWindowStatus(label: string, store: KV = defaultStore()): void {
  const map = readMap(store);
  if (label in map) {
    delete map[label];
    writeMap(store, map);
  }
  emitNow();
}

/** Wipe the whole map. The main window calls this at cold start (mirrors resetWindowRegistry) so a
 *  hard crash that skipped the unload cleanup can't leave ghost rows for windows that no longer
 *  exist. Cold-start-ONLY: it runs before any other window exists, so — like resetWindowRegistry —
 *  it deliberately does not emit; there is no other window to notify. */
export function resetWindowStatus(store: KV = defaultStore()): void {
  store.setItem(WINDOW_STATUS_KEY, "{}");
}

// waiting/approval (the user is actively blocking) rank before errored (a crash to triage).
function attentionRank(status: AgentTabStatus): number {
  return status === "waiting" || status === "approval" ? 0 : 1;
}

/** Read the shared map, drop the caller's own entry and any entry whose window is no longer open
 *  (cross-checked against the windowRegistry), flatten to one row per red agent, and sort by
 *  attention rank, then project name, then agent name. */
export function readOtherWindowsRedAgents(
  selfLabel: string,
  store: KV = defaultStore(),
): OtherWindowAgent[] {
  const map = readMap(store);
  const out: OtherWindowAgent[] = [];
  for (const [windowLabel, entry] of Object.entries(map)) {
    if (windowLabel === selfLabel) continue;
    if (!entry || !entry.projectId) continue; // skip a malformed/partial blob entry
    // The owning window is open iff ITS label is still registered. Label-keyed (not project-keyed):
    // a window's own unload clears its registry entry, and a crash + "Replace" that re-points the
    // same project to a DIFFERENT live window must not keep this dead label's stale red agents.
    if (!isWindowOpen(windowLabel, store)) continue;
    for (const a of entry.agents ?? []) {
      if (!a || !a.id) continue; // skip a malformed agent item from a partial blob
      out.push({
        windowLabel,
        projectId: entry.projectId,
        projectName: entry.projectName ?? entry.projectId,
        agentId: a.id,
        agentName: a.name,
        status: a.status,
      });
    }
  }
  out.sort(
    (a, b) =>
      attentionRank(a.status) - attentionRank(b.status) ||
      a.projectName.localeCompare(b.projectName) ||
      a.agentName.localeCompare(b.agentName),
  );
  return out;
}

// ---------------------------------------------------------------------------
// useSyncExternalStore plumbing for the selector hook (useOtherWindowsRedAgents).
// ---------------------------------------------------------------------------

/** Subscribe to cross-window status changes: the reliable Tauri `sparkle://status-changed` event
 *  plus a `storage` listener (covers dev/tests and also the windowRegistry key, since a window
 *  closing changes which entries count as open). Returns an unsubscribe fn; no-op outside a DOM. */
export function subscribeWindowStatus(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === WINDOW_STATUS_KEY || e.key === WINDOW_REGISTRY_KEY || e.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  let unlisten: UnlistenFn | undefined;
  let cancelled = false;
  if (inTauri()) {
    void listen(STATUS_CHANGED_EVENT, () => onChange()).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
  }
  return () => {
    cancelled = true;
    window.removeEventListener("storage", onStorage);
    unlisten?.();
  };
}

// Cached snapshot per selfLabel so useSyncExternalStore's getSnapshot returns a STABLE reference
// until the underlying data actually changes — returning a fresh array each call would make React
// loop forever ("getSnapshot should be cached"). Module-global and intentionally NOT reset by
// localStorage.clear(): the cache key is the serialized value, so any storage change still busts it
// (a stale entry can never be returned), and the retained arrays are bounded by the live label set.
const snapCache = new Map<string, { key: string; value: OtherWindowAgent[] }>();
export function getOtherWindowsSnapshot(selfLabel: string): OtherWindowAgent[] {
  const value = readOtherWindowsRedAgents(selfLabel);
  const key = JSON.stringify(value);
  const prev = snapCache.get(selfLabel);
  if (prev && prev.key === key) return prev.value;
  snapCache.set(selfLabel, { key, value });
  return value;
}
