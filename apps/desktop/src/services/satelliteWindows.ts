// WHO OWNS A TORN-OUT PROJECT — the one piece of state the tear-off feature cannot live without.
//
// A satellite (src-tauri/src/project_window.rs, `?view=project&project=<id>`) renders columns ② + ③
// for exactly one project. The main window MUST stop rendering that project's agent panes the
// moment it is torn out, because a Terminal unmount KILLS its PTY (Terminal.tsx's cleanup calls
// `transport.detach()`, and for a local agent detach IS kill) — so two windows mounting the same
// agent means two xterms racing one PTY, which is precisely what the single-window shell existed to
// prevent (Workspace.tsx's pane-mounting note).
//
// WHY A SEPARATE MAP FROM `windowRegistry`. That module answers "what is window L showing?" — a
// per-window CURSOR that main rewrites on every tab click. This answers the inverse and much
// stickier question, "has project P been taken away from main?", and its lifetime is the satellite's,
// not a selection's. Overloading one blob with both would have made main's ordinary tab switches
// write through the ownership channel. Satellites still write `windowRegistry` too (that is what
// capture-send routing reads); this map is what the pane gate reads.
//
// WHY localStorage + A TAURI EVENT, and not uiStore. Two reasons, both load-bearing:
//   • uiStore is NOT cross-window synced, and a satellite writing it would clobber main's whole
//     persisted `sparkle-ui` blob (openProjectTab.ts:95-105 — the same hazard the PRD calls out).
//   • the browser `storage` event is not reliably delivered between Tauri webviews (WKWebView on
//     macOS especially — see crossWindowSync.ts's header). So the RELIABLE channel is a Tauri
//     event; `storage` is kept as a best-effort bonus, exactly as crossWindowSync does it.
//
// ORDERING IS THE WHOLE DESIGN. Every transition is "the old owner unmounts, THEN the new one
// mounts", never the reverse:
//   • tear-off: `claimSatellite` first (main drops the panes and its PTYs die), THEN the window is
//     built. A failed build rolls the claim back, so a refused tear-off costs a respawn and nothing
//     else.
//   • re-dock: the satellite unmounts its panes, THEN releases, THEN destroys itself — and
//     `reclaimProject` waits on `close_project_window`, which does not return until the window has
//     actually left the manager.
// Overlapping the two would spawn a second PTY for an agent id that already has one.

import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { safeUnlisten } from "./safeUnlisten";
import type { KV } from "./windowRegistry";

/**
 * The localStorage-backed KV, with the same no-op fallback `windowRegistry.defaultStore` uses.
 *
 * Six duplicated lines rather than importing that function, and the duplication is the point: this
 * module is now reached from `Workspace`'s render, so importing a VALUE from windowRegistry made
 * every existing suite that mocks windowRegistry (for its own reasons, with its own partial mock)
 * fail at `defaultStore is not exported` — two files and seven tests, none of which have anything to
 * do with satellites. The TYPE import above is erased at compile time and costs nothing. If a third
 * copy of this ever appears, hoist it to its own module rather than re-coupling these two.
 */
function defaultStore(): KV {
  return typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {} };
}

/** localStorage key of the projectId → satellite-label map. */
export const SATELLITE_REGISTRY_KEY = "sparkle-satellite-projects";

/**
 * The footprint Rust builds a satellite at — `DEFAULT_W` × `DEFAULT_H` in project_window.rs.
 *
 * Mirrored here because the DROP POSITION is computed on this side: `tearOffTopLeft` centres the
 * window on the cursor and `clampToScreen` keeps it on the display it was dropped over, and both
 * need the size the window will actually be. Guessing wrong doesn't crash anything — it just lands
 * the window off-centre or lets a corner hang off the screen edge. `satelliteWindows.test.ts`
 * asserts these against the Rust constants so the two can't drift silently.
 */
export const SATELLITE_SIZE = { width: 1000, height: 720 } as const;

/**
 * The substring identifying Rust's pool-exhaustion rejection ("all 4 satellite windows are already
 * open", project_window.rs). Lives here, beside `SATELLITE_SIZE`, because both are the same kind of
 * thing: a value mirrored across the language boundary that nothing enforces at build time. It was
 * WRONG on first write — the frontend matched `"no free"`, which the backend never says — so the one
 * tear-off failure a user can act on fell through to the generic message. `satelliteSize.test.ts`
 * greps the Rust source for both.
 */
export const POOL_EXHAUSTED_MARKER = "satellite windows are already open";

/** Turn a tear-off rejection into something worth showing a person. */
export function tearOffErrorMessage(e: unknown): string {
  return String(e).includes(POOL_EXHAUSTED_MARKER)
    ? "All four project windows are in use. Bring one back into the main window first."
    : "Could not open that project in its own window.";
}

/** Tauri event broadcast on every ownership write — the reliable cross-webview channel. */
export const SATELLITES_CHANGED_EVENT = "sparkle://satellites-changed";

/**
 * Main asking a satellite to re-dock ITSELF. Payload: `{ projectId }`.
 *
 * This exists because destroying the window from outside is not a close — it is an execution.
 * `close_project_window` calls `Window::destroy`, which tears the webview down without running any
 * React cleanup, so the satellite's `Terminal` unmount — and therefore `transport.detach()`, which
 * for a local agent IS `kill()` — never happens. Main would then release the project, remount those
 * agents, and `pty_spawn`'s `sessions.insert` would REPLACE the map entry, leaving the satellite's
 * `claude` child running with nothing holding its handle. That is precisely the orphaned-PTY case
 * this whole module exists to prevent, and it sat on the primary user-facing re-dock path.
 *
 * So main asks, the satellite runs its own ordered teardown (panes down → settle → release →
 * destroy), and `close_project_window` stays only as the bounded fallback for a satellite that
 * cannot answer.
 */
export const SATELLITE_REDOCK_EVENT = "sparkle://satellite-redock";

/** How long main waits for a satellite to hand the project back before forcing the window closed.
 *  Comfortably longer than the satellite's own CLOSE_SETTLE_MS (250ms) plus a render, short enough
 *  that a wedged webview doesn't leave the user staring at a button that did nothing. */
export const REDOCK_TIMEOUT_MS = 2500;

/**
 * How often the re-dock request is REPEATED while waiting.
 *
 * Tauri does not buffer an event for a webview that hasn't registered its listener yet, and there is
 * a real gap where that is true: `tearOffProject` records the label — which is what puts "Bring it
 * back here" in front of the user — as soon as `open_project_window` resolves, which is before the
 * satellite's React tree has mounted and called `listen`. A single emit into that gap is lost, main
 * waits out the whole timeout, and then force-destroys a satellite whose panes are by then fully
 * mounted: the orphaned-PTY case, reached from the primary button. Repeating is the cheap fix (the
 * satellite stops listening the moment it starts closing) and it needs no ready-ack protocol.
 */
export const REDOCK_RETRY_MS = 400;

/** Same-window DOM event, because `storage` only ever fires in OTHER windows. */
const LOCAL_CHANGE_EVENT = "sparkle:satellites-changed";

/**
 * projectId → the satellite window label showing it, or `null` while the tear-off is still in
 * flight (the claim is written BEFORE the window is built — see the header's ordering note).
 *
 * A key being PRESENT is what gates the panes; the value only matters to whoever needs to talk to
 * the window (focus it, close it). That asymmetry is deliberate: a pending tear-off must already
 * have taken the project away from main, or main would keep the PTYs alive into the satellite's
 * first mount.
 */
export type SatelliteMap = Record<string, string | null>;

// ── pure core ───────────────────────────────────────────────────────────────────────────────────

export function readSatellites(store: KV = defaultStore()): SatelliteMap {
  try {
    const raw = store.getItem(SATELLITE_REGISTRY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Drop anything that isn't `string | null`: the blob is shared, durable, and hand-editable, and
    // a `{p: 3}` would otherwise reach `close_project_window` as a label.
    const out: SatelliteMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Prune entries whose window is gone, returning the pruned map — or `null` when nothing changed.
 *
 *  PENDING entries (`null` label) are NEVER pruned: they name a window that has not been built yet,
 *  so "its label isn't live" is the expected state, and pruning it would hand the project back to
 *  main mid-tear-off — main remounts, spawns a PTY, and the satellite that lands a moment later
 *  spawns a second one for the same agent. The claim is rolled back by whoever made it (see
 *  `tearOffProject`), which is the only party that can tell "still building" from "died". */
export function pruneSatellites(map: SatelliteMap, liveLabels: readonly string[]): SatelliteMap | null {
  const live = new Set(liveLabels);
  const out: SatelliteMap = {};
  let changed = false;
  for (const [projectId, label] of Object.entries(map)) {
    if (label === null || live.has(label)) out[projectId] = label;
    else changed = true;
  }
  return changed ? out : null;
}

/** The label showing `projectId`, or null when it is main's (or the tear-off is still pending). */
export function satelliteLabelIn(map: SatelliteMap, projectId: string): string | null {
  return map[projectId] ?? null;
}

/** Has this project been taken away from the main window? True for a PENDING claim too — see
 *  `SatelliteMap`. */
export function isTornOutIn(map: SatelliteMap, projectId: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, projectId);
}

// ── writes ──────────────────────────────────────────────────────────────────────────────────────

function write(map: SatelliteMap, store: KV): void {
  store.setItem(SATELLITE_REGISTRY_KEY, JSON.stringify(map));
  // Same-window subscribers first (synchronously, so a claim takes effect in the very next React
  // render), then the cross-window fan-out. Both are best-effort: a shim `window` without
  // dispatchEvent, or a plain-browser preview with no Tauri, must not fail the write itself.
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
  }
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    void emit(SATELLITES_CHANGED_EVENT).catch(() => {});
  }
}

/** Take `projectId` away from the main window, before the satellite exists. Idempotent. */
export function claimSatellite(projectId: string, store: KV = defaultStore()): void {
  const map = readSatellites(store);
  // Don't downgrade a settled label back to pending — a second claim for an already-torn-out
  // project would otherwise lose the label the re-dock path needs to close the window.
  if (isTornOutIn(map, projectId)) return;
  map[projectId] = null;
  write(map, store);
}

/** Record which window won the claim. */
export function settleSatellite(projectId: string, label: string, store: KV = defaultStore()): void {
  const map = readSatellites(store);
  map[projectId] = label;
  write(map, store);
}

/** Hand `projectId` back to the main window. Idempotent. */
export function releaseSatellite(projectId: string, store: KV = defaultStore()): void {
  const map = readSatellites(store);
  if (!isTornOutIn(map, projectId)) return;
  delete map[projectId];
  write(map, store);
}

/** Wipe every entry — the main window's cold-start hygiene, mirroring `resetWindowRegistry`. The
 *  blob outlives the process; satellites do not. */
export function resetSatellites(store: KV = defaultStore()): void {
  write({}, store);
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────

export function satelliteLabelFor(projectId: string, store: KV = defaultStore()): string | null {
  return satelliteLabelIn(readSatellites(store), projectId);
}

export function isTornOut(projectId: string, store: KV = defaultStore()): boolean {
  return isTornOutIn(readSatellites(store), projectId);
}

/** Every project currently owned by a satellite — the set main's pane gate subtracts. */
export function tornOutProjectIds(store: KV = defaultStore()): Set<string> {
  return new Set(Object.keys(readSatellites(store)));
}

/**
 * The raw persisted blob, for `useSyncExternalStore`.
 *
 * A STRING, not the parsed map or a Set: `getSnapshot` must return something that compares equal
 * across calls when nothing changed, and every `readSatellites()` allocates a fresh object — React
 * would see a new identity on every render and loop forever ("The result of getSnapshot should be
 * cached"). A version counter would work too, but not with several independent subscribers each
 * bumping it; the blob itself is self-consistent by construction.
 */
export function satellitesSnapshot(store: KV = defaultStore()): string {
  return store.getItem(SATELLITE_REGISTRY_KEY) ?? "";
}

/** Parse a `satellitesSnapshot` string back into the map. */
export function parseSnapshot(raw: string): SatelliteMap {
  if (!raw) return {};
  return readSatellites({ getItem: () => raw, setItem: () => {} });
}

// ── subscription ────────────────────────────────────────────────────────────────────────────────

/** Fire `cb` whenever ownership changes, in THIS window or another. Returns an unsubscribe fn. */
export function onSatellitesChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onLocal = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (e.key === SATELLITE_REGISTRY_KEY) cb();
  };
  window.addEventListener(LOCAL_CHANGE_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  let unlisten: (() => void) | null = null;
  let torndown = false;
  if ("__TAURI_INTERNALS__" in window) {
    void listen(SATELLITES_CHANGED_EVENT, () => cb())
      .then((u) => {
        // A handle that resolves AFTER teardown must unlisten itself rather than leak for the life
        // of the webview (the crossWindowSync `isTorndown` idiom). Through safeUnlisten: Tauri's
        // unlisten is async, so a raw `u()` returns a REJECTED promise (not a throw) once the
        // listeners map is torn down, leaking an app-level unhandled rejection (sparkle-6csa).
        if (torndown) void safeUnlisten(u);
        else unlisten = u;
      })
      .catch(() => {});
  }
  return () => {
    torndown = true;
    window.removeEventListener(LOCAL_CHANGE_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
    void safeUnlisten(unlisten);
  };
}

// ── orchestration ───────────────────────────────────────────────────────────────────────────────

/**
 * Tear `projectId` out into its own window at `topLeft` (Tauri global LOGICAL screen coordinates —
 * the space `tabDrag.ts` works in). Resolves to the satellite's label.
 *
 * The claim lands FIRST and is rolled back on failure: see the header. The cost of the rollback is
 * one respawn of that project's local agents (`claude --resume`), which is the same cost the
 * tear-off itself pays — never a lost conversation.
 */
export async function tearOffProject(
  projectId: string,
  topLeft: { x: number; y: number } | null,
): Promise<string> {
  claimSatellite(projectId);
  try {
    const label = await invoke<string>("open_project_window", {
      projectId,
      x: topLeft?.x ?? null,
      y: topLeft?.y ?? null,
    });
    settleSatellite(projectId, label);
    return label;
  } catch (e) {
    releaseSatellite(projectId);
    throw e;
  }
}

/**
 * Wait for `projectId` to leave the ownership map, having asked its satellite to hand it back.
 *
 * Resolves true when the satellite released it (the good path), false on timeout or when the event
 * could not even be emitted. Subscribes BEFORE emitting, so a satellite that answers immediately
 * cannot land its release in the gap between the two.
 */
function requestRedock(projectId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let off: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setInterval> | null = null;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      off?.();
      if (timer) clearTimeout(timer);
      if (retry) clearInterval(retry);
      resolve(ok);
    };
    off = onSatellitesChange(() => {
      if (!isTornOut(projectId)) finish(true);
    });
    timer = setTimeout(() => finish(false), REDOCK_TIMEOUT_MS);
    // Repeat rather than fire once — see REDOCK_RETRY_MS. A failed emit is not fatal either: the
    // next tick tries again, and only the timeout decides we've given up.
    const send = () => void emit(SATELLITE_REDOCK_EVENT, { projectId }).catch(() => {});
    send();
    retry = setInterval(send, REDOCK_RETRY_MS);
  });
}

/** Does a window with this label exist right now? Answers TRUE when it cannot tell — an unanswerable
 *  question must not be read as "the window is gone", because that shortcut skips straight to
 *  releasing a project a live satellite may still be rendering. */
async function windowExists(label: string): Promise<boolean> {
  try {
    const { getAllWindows } = await import("@tauri-apps/api/window");
    return (await getAllWindows()).some((w) => w.label === label);
  } catch {
    return true;
  }
}

/**
 * Bring a torn-out project back into the main window.
 *
 * ASK FIRST, FORCE SECOND — see `SATELLITE_REDOCK_EVENT` for why the obvious implementation
 * (destroy the window, then release) orphans a `claude` process. The satellite runs its own ordered
 * teardown and releases the project itself; only if it doesn't answer within `REDOCK_TIMEOUT_MS` do
 * we destroy the window and release on its behalf.
 *
 * The fallback's ordering is still the careful one: `close_project_window` does not return until the
 * window has actually left the window manager (project_window.rs polls for it), so releasing
 * afterwards means main remounts only once nothing can still be painting into those PTYs. It is a
 * lesser evil, not a good outcome — a window unresponsive enough to miss the event has probably
 * already lost its React tree, and its PTYs may leak. Better a leaked process than a project no
 * window renders.
 *
 * No-op when the project isn't torn out; a PENDING claim is released without any of this, since
 * there is no window to ask yet.
 */
export async function reclaimProject(projectId: string): Promise<void> {
  const label = satelliteLabelFor(projectId);
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!label || !inTauri) {
    releaseSatellite(projectId);
    return;
  }
  // A row pointing at a window that is already gone (force-quit, crash) is the common stale case.
  // Waiting out the full timeout for an answer nobody can give makes the button feel broken for
  // 2.5s, so check first and go straight to the release.
  //
  // `windowExists` awaits a dynamic import and an IPC round trip, so this path has the SAME
  // stale-label exposure as the forced close below — shorter window, identical failure. Re-read
  // before acting on it: releasing a row that moved under us hands back a project a live satellite
  // is rendering, or drops a PENDING row mid-tear-off (which double-spawns that project's PTYs).
  if (!(await windowExists(label))) {
    if (satelliteLabelFor(projectId) !== label) return; // the row moved; our answer is about a
    // window that is no longer this project's, so it says nothing about the one that is.
    releaseSatellite(projectId);
    return;
  }
  if (await requestRedock(projectId)) return; // the satellite tore itself down cleanly

  // RE-READ before forcing. The wait above is long enough for the world to have moved: the
  // satellite may have released and destroyed itself a moment after the timeout fired, freeing its
  // pool slot for a DIFFERENT project's tear-off to take the same `project-N` label. Closing the
  // label captured 2.5s ago would then `Window::destroy` an unrelated satellite with live Terminals
  // in it — the orphaned-PTY case, caused by the very code that exists to prevent it.
  if (!isTornOut(projectId)) return; // someone else already handed it back
  const current = satelliteLabelFor(projectId);
  if (!current) return; // now merely pending — there is no window to close
  console.warn("satellite did not answer the re-dock request; forcing it closed", current);
  try {
    await invoke("close_project_window", { label: current });
  } catch (e) {
    // Report and still release: a satellite we cannot destroy is strictly worse left owning the
    // project, because then NO window renders it and the tab is dead.
    console.warn("close_project_window failed; releasing anyway", current, e);
  }
  releaseSatellite(projectId);
}

/**
 * Raise the satellite showing `projectId`. Resolves to false when there is nothing to raise.
 *
 * This is the OTHER half of the main window's placeholder: a torn-out project's tab still exists in
 * the strip, and clicking it must be able to say "it's over there" AND take you there — otherwise a
 * window buried behind the main one, or minimized, reads as a project that simply vanished.
 *
 * `unminimize` before `setFocus` because focusing a minimized window is a no-op on macOS — it comes
 * back to the front only if it is restored first. Both permissions are granted to the `project-N`
 * pool in capabilities/default.json; the retired geometry ones (set-position/set-size/close) are
 * deliberately NOT used here — raising a window is not moving it.
 */
export async function focusSatellite(projectId: string): Promise<boolean> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return false;
  const label = satelliteLabelFor(projectId);
  // A PENDING claim (null label) has no window yet — nothing to raise, and no error either: the
  // window is milliseconds away and the user can click again.
  if (!label) return false;
  try {
    const { getAllWindows } = await import("@tauri-apps/api/window");
    const w = (await getAllWindows()).find((x) => x.label === label);
    if (!w) return false;
    if (await w.isMinimized()) await w.unminimize();
    await w.setFocus();
    return true;
  } catch (e) {
    console.warn("focusSatellite failed", label, e);
    return false;
  }
}

/** Is this one of the satellite pool's window labels? Mirrors project_window.rs's POOL naming. */
function isSatelliteLabel(label: string): boolean {
  return /^project-\d+$/.test(label);
}

/**
 * Drop ownership rows whose window no longer exists — the crash/force-quit backstop for a satellite
 * that never got to release itself. Main-window only; returns true when it pruned.
 *
 * `boot: true` additionally clears PENDING rows, but ONLY when no satellite window exists at all.
 * That combination is what makes it safe to call at startup: a pending row is normally protected
 * (see `pruneSatellites`) because it names a window that is still being built, and dropping it
 * mid-tear-off double-spawns the project's PTYs. With zero satellites on screen there is no
 * tear-off in flight to protect, so a pending row can only be a leftover from a process that died
 * between the claim and the build — which would otherwise strand that project forever.
 *
 * This REPLACED an unconditional `resetSatellites()` in `AppBoot`. That wipe read as cold-start
 * hygiene but ran on every mount of `<App/>`: the error card's "Reload UI" remounts the tree, and so
 * does an HMR update. Live satellites are unaffected by a main-window reload, so the wipe handed
 * their projects back while their panes were still on screen — main remounted the same agent ids and
 * both webviews raced one PTY. A reconcile cannot do that: a live satellite's row survives because
 * its window is live.
 */
export async function reconcileSatellites(opts: { boot?: boolean } = {}): Promise<boolean> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return false;
  const map = readSatellites();
  if (Object.keys(map).length === 0) return false;
  let live: string[];
  try {
    const { getAllWindows } = await import("@tauri-apps/api/window");
    live = (await getAllWindows()).map((w) => w.label);
  } catch (e) {
    // LEAVE THE MAP ALONE, and do not reject. Both callers invoke this as `void
    // reconcileSatellites(...)` — AppBoot once, and Workspace on every window focus — so an
    // unguarded throw here is an unhandled rejection on an ordinary user action. And the safe
    // reading of "I could not enumerate the windows" is "change nothing": treating it as "no window
    // is live" would prune rows for satellites that are on screen, which is the duplicate-PTY case.
    console.debug("satellite reconcile skipped; leaving the ownership map as-is", e);
    return false;
  }
  if (opts.boot && !live.some(isSatelliteLabel)) {
    write({}, defaultStore());
    return true;
  }
  const pruned = pruneSatellites(map, live);
  if (!pruned) return false;
  write(pruned, defaultStore());
  return true;
}
