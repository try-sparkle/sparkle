// Cross-window LIVE STATUS channel — the one piece crossWindowSync doesn't carry. Each window's
// agent status (runtimeStore.status) is per-window and never persisted/shared, so a window can't
// otherwise see that an agent in ANOTHER open window has gone red. This module mirrors the
// roster/registry patterns: a shared localStorage map every window can read, with each window
// writing ONLY its own label's entry (its red agents), broadcast via a Tauri event so other
// windows re-read. Reliable path is the Tauri `emit` (the browser `storage` event isn't reliably
// delivered across separate WKWebViews); we also write storage so dev/tests fan out via `storage`.
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AGENT_STATUS } from "@sparkle/ui";
import {
  isWindowOpen,
  getWindowProject,
  openWindowLabels,
  removeKey,
  allKeys,
  defaultStore,
  WINDOW_REGISTRY_KEY,
  type KV,
} from "./windowRegistry";
import { safeUnlisten } from "./safeUnlisten";
import type { AgentTabStatus } from "../types";

/** LEGACY single-blob key. Every window used to read-modify-write this ONE map, which is not atomic
 *  across separate WKWebViews — so a publish could drop another window's entry or resurrect one it
 *  had just deleted, and nothing ever corrected it (sparkle-csq2). Kept only so resetWindowStatus
 *  can clear a blob left by an older build. */
export const WINDOW_STATUS_KEY = "sparkle-window-status";

/** Per-window key prefix: each window owns `sparkle-window-status:<label>` and writes ONLY that key.
 *  There is no shared map to read-modify-write, so the lost-update race is gone BY CONSTRUCTION —
 *  a heartbeat would only have masked it. Readers enumerate the open windows (windowRegistry) and
 *  read each one's key. */
export const WINDOW_STATUS_KEY_PREFIX = "sparkle-window-status:";

/** This window's own status key. */
export function windowStatusKey(label: string): string {
  return `${WINDOW_STATUS_KEY_PREFIX}${label}`;
}
export const STATUS_CHANGED_EVENT = "sparkle://status-changed";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** A red agent as published by its owning window (display name already resolved). */
export interface WindowRedAgent {
  id: string;
  name: string;
  status: AgentTabStatus;
  /** Epoch ms when this agent entered the red tier — used to pick the most-recently-red
   *  representative when collapsing a window's red agents to one row. Blobs from windows on
   *  OLDER builds omit it; readers treat a missing/invalid value as 0 (see `sinceOf`). */
  since?: number;
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
  /** Epoch ms when the agent entered the red tier (0 when the publishing window was on an older
   *  build that didn't stamp it). Drives the "most recent" representative pick in the grouped view. */
  since: number;
}

/** One OTHER open window collapsed to a single sidebar row: the representative (most-recently-red)
 *  agent plus the TOTAL count of red agents in that window. The sidebar renders `agent` and shows a
 *  "+{count - 1}" badge when count > 1. */
export interface OtherWindowGroup {
  windowLabel: string;
  projectId: string;
  projectName: string;
  agent: OtherWindowAgent;
  count: number;
}

/** Coerce a possibly-missing/invalid `since` (old blobs, non-numbers, NaN) to a comparable 0. */
function sinceOf(since: unknown): number {
  return typeof since === "number" && Number.isFinite(since) ? since : 0;
}

/** Read ONE window's entry. Returns null when absent, empty (the removeItem-less shim writes ""),
 *  or malformed. */
function readEntry(store: KV, label: string): WindowStatusEntry | null {
  try {
    const raw = store.getItem(windowStatusKey(label));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as WindowStatusEntry) : null;
  } catch {
    return null;
  }
}

/** Read every OPEN window's entry as the map shape the readers below expect. The open-window set
 *  comes from the windowRegistry, so a crashed window's leftover key is never surfaced. */
function readMap(store: KV): WindowStatusMap {
  const out: WindowStatusMap = {};
  for (const label of openWindowLabels(store)) {
    const entry = readEntry(store, label);
    if (entry) out[label] = entry;
  }
  return out;
}

// The "needs your action" (RED) statuses are exactly those whose AGENT_STATUS color is the brand
// red — waiting, approval, errored, blocked, unmerged (packages/ui/tokens.ts). This is the FULL
// red-COLOR tier and is deliberately BROADER than the narrower badge/relay set (waiting|approval|
// errored) used by engine/attention.needsAttention + useAttentionNotifications.isRelayRed: this
// cross-window feature surfaces every red-colored agent (blocked/unmerged included) so nothing that
// needs you is hidden in another project. The subtype below lists the same five statuses so the
// type guard narrows SOUNDLY — it must stay in sync with the runtime color check (adding a red token
// to tokens.ts means adding it here too).
export type RedStatus = "waiting" | "approval" | "errored" | "blocked" | "unmerged";
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
 *  broadcast (debounced). Other windows re-read and recompute their cross-window section.
 *
 *  `immediate` flushes the broadcast instead of debouncing it (~250ms). Pass it when THIS window
 *  changed PROJECT: until other windows re-read, their last snapshot still shows this window's
 *  previous project's red agents, and the reader's staleness guard only runs when they re-read.
 *  Ordinary status ticks stay debounced — they're frequent and a quarter-second late is harmless. */
export function publishWindowRedAgents(
  label: string,
  projectId: string,
  projectName: string,
  redAgents: WindowRedAgent[],
  store: KV = defaultStore(),
  immediate = false,
): void {
  // Touches ONLY this window's key — never another window's data, so there is nothing to lose.
  if (redAgents.length === 0) {
    if (readEntry(store, label) === null) return; // nothing to change, skip the write + broadcast
    removeKey(store, windowStatusKey(label));
  } else {
    store.setItem(
      windowStatusKey(label),
      JSON.stringify({ projectId, projectName, agents: redAgents } satisfies WindowStatusEntry),
    );
  }
  if (immediate) emitNow();
  else scheduleEmit();
}

/** Remove THIS window's entry and broadcast immediately. Called on window unload, so we flush the
 *  emit rather than leaving it on a debounce timer the closing window may never run. */
export function clearWindowStatus(label: string, store: KV = defaultStore()): void {
  if (readEntry(store, label) !== null) removeKey(store, windowStatusKey(label));
  emitNow();
}

/** Wipe the whole map. The main window calls this at cold start (mirrors resetWindowRegistry) so a
 *  hard crash that skipped the unload cleanup can't leave ghost rows for windows that no longer
 *  exist. Cold-start-ONLY: it runs before any other window exists, so — like resetWindowRegistry —
 *  it deliberately does not emit; there is no other window to notify. */
export function resetWindowStatus(store: KV = defaultStore()): void {
  // Sweep by PREFIX, not by the registry: this runs after a hard crash, which may also have left
  // the registry empty/stale — keying the wipe off registered labels would then orphan exactly the
  // ghost entries this exists to clear. Fall back to the registry only if the KV can't enumerate.
  const keys = allKeys(store);
  if (keys) {
    for (const k of keys) if (k.startsWith(WINDOW_STATUS_KEY_PREFIX)) removeKey(store, k);
  } else {
    for (const label of openWindowLabels(store)) removeKey(store, windowStatusKey(label));
  }
  removeKey(store, WINDOW_STATUS_KEY); // drop a legacy shared blob from an older build
}

// waiting/approval (the user is actively blocking) rank before errored (a crash to triage).
function attentionRank(status: AgentTabStatus): number {
  return status === "waiting" || status === "approval" ? 0 : 1;
}

// Which of two red agents is the better "most-recently-red" representative for its window's collapsed
// row: newest `since` wins, then lower attentionRank, then agentName — a total order so the pick is
// stable when timestamps tie or are absent (old blobs → since 0). Negative ⇒ `a` outranks `b`.
function compareRep(a: OtherWindowAgent, b: OtherWindowAgent): number {
  return (
    b.since - a.since ||
    attentionRank(a.status) - attentionRank(b.status) ||
    a.agentName.localeCompare(b.agentName)
  );
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
    // PROJECT STALENESS: `entry.projectId` is SELF-REPORTED by the owning window and lags a
    // "Replace" — that window swaps its project in place under the SAME label, so the registry
    // flips to the new project immediately while this blob still carries the OLD project's red
    // agents until the owner republishes. Trusting that gap surfaced a card for a project the
    // window no longer shows into a freshly-opened window's sidebar (a card "leaking in" from an
    // unrelated project). The registry is the authority on what a window shows NOW, so only trust
    // an entry that still agrees with it; the owner's republish re-admits it a moment later.
    if (entry.projectId !== getWindowProject(windowLabel, store)) continue;
    for (const a of entry.agents ?? []) {
      if (!a || !a.id) continue; // skip a malformed agent item from a partial blob
      out.push({
        windowLabel,
        projectId: entry.projectId,
        projectName: entry.projectName ?? entry.projectId,
        agentId: a.id,
        agentName: a.name,
        status: a.status,
        since: sinceOf(a.since),
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

/** Collapse the flat cross-window red list to ONE group per OTHER window. Each group's visible row
 *  is the representative — the agent with the LARGEST `since` (most recently entered red); ties break
 *  by attentionRank then agentName so the pick is deterministic when timestamps are equal or absent
 *  (old blobs). `count` is the TOTAL red agents in that window, so the sidebar renders "+{count - 1}".
 *  Groups sort by representative attentionRank, then representative `since` DESC (most recent first),
 *  then projectName. Reuses readOtherWindowsRedAgents so the own-label / open-window / malformed-blob
 *  filtering stays in one place. */
export function readOtherWindowsRedGroups(
  selfLabel: string,
  store: KV = defaultStore(),
): OtherWindowGroup[] {
  const flat = readOtherWindowsRedAgents(selfLabel, store);
  const byWindow = new Map<string, OtherWindowAgent[]>();
  for (const a of flat) {
    const list = byWindow.get(a.windowLabel);
    if (list) list.push(a);
    else byWindow.set(a.windowLabel, [a]);
  }
  const groups: OtherWindowGroup[] = [];
  for (const [windowLabel, agents] of byWindow) {
    // Representative = most recently red; deterministic tie-break (attentionRank, then agentName) so
    // equal/absent timestamps don't flap the visible row between renders. reduce keeps the "better"
    // one — negative compareRep means `a` outranks the incumbent.
    const rep = agents.reduce((best, a) => (compareRep(a, best) < 0 ? a : best));
    groups.push({
      windowLabel,
      projectId: rep.projectId,
      projectName: rep.projectName,
      agent: rep,
      count: agents.length,
    });
  }
  groups.sort(
    (a, b) =>
      attentionRank(a.agent.status) - attentionRank(b.agent.status) ||
      b.agent.since - a.agent.since ||
      a.projectName.localeCompare(b.projectName) ||
      // Final total-order tiebreak: two OTHER windows on the SAME project with equal rank and equal
      // `since` (e.g. both 0 from old-build blobs) would otherwise fall back to Map insertion order.
      a.windowLabel.localeCompare(b.windowLabel),
  );
  return groups;
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
    if (
      e.key === null ||
      e.key === WINDOW_REGISTRY_KEY ||
      e.key === WINDOW_STATUS_KEY ||
      e.key.startsWith(WINDOW_STATUS_KEY_PREFIX)
    )
      onChange();
  };
  window.addEventListener("storage", onStorage);
  // Keep the listen() promise; safeUnlisten awaits it on cleanup so a listener that resolves AFTER
  // unsubscribe is still torn down (and the Tauri teardown race is swallowed).
  const unlistenPromise: Promise<UnlistenFn> | undefined = inTauri()
    ? listen(STATUS_CHANGED_EVENT, () => onChange())
    : undefined;
  return () => {
    window.removeEventListener("storage", onStorage);
    void safeUnlisten(unlistenPromise);
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

// Same STABLE-reference contract as getOtherWindowsSnapshot, but for the grouped view. Separate
// cache so the two snapshots don't clobber each other's keys; JSON-of-value key busts on any change.
const groupsSnapCache = new Map<string, { key: string; value: OtherWindowGroup[] }>();
export function getOtherWindowsGroupsSnapshot(selfLabel: string): OtherWindowGroup[] {
  const value = readOtherWindowsRedGroups(selfLabel);
  const key = JSON.stringify(value);
  const prev = groupsSnapCache.get(selfLabel);
  if (prev && prev.key === key) return prev.value;
  groupsSnapCache.set(selfLabel, { key, value });
  return value;
}
