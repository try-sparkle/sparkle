// PER-SLOT IN-FLIGHT LATCHES FOR THE BACKLOG-DRAIN FLEET — a LEAF, deliberately, exactly like
// improvementPassLatch (see that file's header for why the latch lives in an import-free leaf: a
// reader of the boolean must never acquire the drain runner's heavy Tauri/store graph).
//
// The hourly pass has ONE latch (a bare boolean). The drain fleet has up to
// DRAIN_CONCURRENCY_HARD_CAP workers running AT ONCE, each in its own worktree under its own slot id,
// so the latch is a SET of the slot ids currently in flight rather than a single flag. A slot is
// claimed BEFORE its worker spawns (claim-before-spawn, the same dedup discipline the shell engine
// and drainerBridge use) and released when the worker settles.
//
// Module state, not store state, for the same reason as improvementPassLatch: it guards real child
// processes in THIS webview and must reset with the page.

const inFlight = new Set<string>();

/** How many drain workers are in flight right now (the fleet's current occupancy). */
export function busyDrainSlotCount(): number {
  return inFlight.size;
}

/** Is this specific slot already running? */
export function isDrainSlotBusy(slot: string): boolean {
  return inFlight.has(slot);
}

/** The slot ids in flight right now (a copy — mutating it must not disturb the latch). */
export function busyDrainSlots(): string[] {
  return [...inFlight];
}

/** Claim a slot. Returns false when it is already in flight, so the caller bails — the has-and-add
 *  is ONE operation here on purpose (two statements at the call site is the shape a second claim can
 *  slip between). */
export function claimDrainSlot(slot: string): boolean {
  if (inFlight.has(slot)) return false;
  inFlight.add(slot);
  return true;
}

/** Release a slot. Safe to call when it is not held. */
export function releaseDrainSlot(slot: string): void {
  inFlight.delete(slot);
}

/** Test seam: forget every in-flight slot, as a fresh webview would. */
export function resetDrainSlotsForTests(): void {
  inFlight.clear();
}
