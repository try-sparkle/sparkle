// The RED-STATUS predicate — all that survives of the cross-window live-status channel.
//
// That channel existed because agent status (runtimeStore.status) is per-window and never shared:
// with several windows open, one window couldn't see that an agent in ANOTHER had gone red. Each
// window wrote its own `sparkle-window-status:<label>` key and broadcast a Tauri event so the
// others re-read, and every window rendered the result as a block at the top of its sidebar.
//
// CM-U7 part 2 deleted that reader along with the multi-window shell (one window now shows every
// project, and the tab bar carries other projects' reds), which left a WRITER WITH NO READER: a
// localStorage write plus an IPC emit on every status change, feeding nothing (roborev 46485-M).
// The publish call, the per-window keys, the subscribe/snapshot API and the debounced emit are gone.
//
// What survives is the color rule, which live consumers still need — the concierge feed's P0/P1/P2
// banding (services/conciergeFeed) and the alert-dismissal tiers — plus a one-shot cleanup of the
// storage the old channel left behind. It stays in this file so those imports don't churn.
import { AGENT_STATUS } from "@sparkle/ui";
import type { AgentTabStatus } from "../types";

// A status is RED when its token color is the error red — that IS the definition, so the predicate
// asks the token map rather than restating a list that could drift from tokens.ts. This is the
// red-COLOR tier and is deliberately BROADER than the narrower badge/relay set (waiting|approval|
// errored) used by engine/attention.needsAttention + useAttentionNotifications.isRelayRed: the wide
// tier surfaces every red-colored agent (`blocked` included) so nothing that needs you is hidden.
// The subtype below lists the same four statuses so the type guard narrows SOUNDLY — it must stay in
// sync with the runtime color check (adding a red token to tokens.ts means adding it here).
//
// `unmerged` LEFT this tier on 2026-07-26: it is a landing state, not an alarm, and it was true of
// most of a real fleet at any moment (see the token's own comment). It is still a status, still
// labeled, and still sorted above the calm tier — it just isn't red, so it isn't here.
export type RedStatus = "waiting" | "approval" | "errored" | "blocked";
const RED = AGENT_STATUS.errored.color;
export function isRedStatus(status: AgentTabStatus | undefined): status is RedStatus {
  return status != null && AGENT_STATUS[status]?.color === RED;
}

/** LEGACY storage keys from the deleted channel: the original shared blob and the per-window keys
 *  that replaced it. Only `resetWindowStatus` touches them now. */
export const WINDOW_STATUS_KEY = "sparkle-window-status";
export const WINDOW_STATUS_KEY_PREFIX = "sparkle-window-status:";

/** Clear every trace of the old channel from storage. Called once at boot (AppBoot) so blobs
 *  written by an older build don't sit in localStorage forever; safe to call repeatedly, and a
 *  no-op where `localStorage` is unavailable. Delete this and its caller after a release or two. */
export function resetWindowStatus(): void {
  try {
    localStorage.removeItem(WINDOW_STATUS_KEY);
    // Enumerate with the INDEX API (`length`/`key`), not `Object.keys`: that is the interface every
    // Storage implementation here actually provides — the test shim in src/test-setup.ts exposes
    // exactly these two, so an `Object.keys` sweep silently cleans nothing under test. Walking
    // BACKWARDS keeps the indices of the not-yet-visited keys stable as entries are removed;
    // forwards, each removal shifts the rest down and the loop skips every other match.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(WINDOW_STATUS_KEY_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // No localStorage (non-DOM test env): there is nothing to clean up.
  }
}
