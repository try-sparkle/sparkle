// WHERE THE CONFLICT EVIDENCE LIVES BETWEEN THE PROBE AND THE SWEEP.
//
// `PusherRunnerDeps.snapshots()` is SYNCHRONOUS — it reads zustand — and so is `conflicts()`. The
// probe that produces this evidence is not: it is a Tauri command that shells out to `gh`. A store
// is the seam that lets one be async and the other not, exactly as `runtimeStore.branchStatus`
// already does for the branch poller the fleet snapshot reads.
//
// ── THE ONLY RULE THIS FILE HAS, AND IT IS THE WHOLE REASON IT IS NOT A PLAIN ARRAY ──────────────
// `undefined` means WE DID NOT LOOK. `[]` means WE LOOKED AND THERE ARE NONE. Those are different
// facts, and conflating them is precisely how a detector reports an all-clear while `gh` is
// unauthenticated — the failure mode the whole `pr-conflicting` class exists to end, reintroduced at
// its own front door.
//
// So the initial state is `undefined`, and the ONLY way to leave it is
// {@link ConflictState.setConflictFlags}, which a caller may reach only with a reading it actually
// obtained. There is deliberately no setter that can write `undefined` back: see
// {@link ConflictState.setConflictFlags} for why a failed re-read keeps the last good answer instead.
import { create } from "zustand";
import type { ConflictingPr } from "@sparkle/core";

export interface ConflictState {
  /**
   * The last authoritative reading, or `undefined` for NEVER LOOKED.
   *
   * `undefined` also covers the two cases that are indistinguishable from never having looked and
   * must behave the same way: a backend with no `conflict_flags` command at all, and a first probe
   * that failed before it could answer.
   */
  flags: readonly ConflictingPr[] | undefined;
  /**
   * Record a reading the probe actually returned.
   *
   * A LATER FAILED READ DOES NOT CLEAR THIS, and that is a considered choice rather than an
   * oversight. A conflicting PR does not heal itself between polls, so the last reading stays true
   * for far longer than the poll interval; and clearing on failure would make the condition
   * disappear and return, which drops its cooldown stamp (`fleetObservationMemory` expires the stamp
   * of any class that is not firing) and re-reports the identical paragraph on the next success.
   * That is the "a transient absence must not reset the containment" rule `pusherRunner` has now
   * learned four separate times. The fail-closed half is upstream: nothing may synthesise a reading,
   * so a probe that cannot read `gh` calls nothing here at all.
   */
  setConflictFlags(list: readonly ConflictingPr[]): void;
  /** Test seam: back to NEVER LOOKED. Not a production path — see above. */
  _resetForTests(): void;
}

export const useConflictStore = create<ConflictState>((set) => ({
  flags: undefined,
  setConflictFlags: (list) => set({ flags: list }),
  _resetForTests: () => set({ flags: undefined }),
}));
