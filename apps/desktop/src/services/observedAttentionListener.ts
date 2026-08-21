// observedAttentionListener — the transport for the mount-independent attention verdict.
//
// The Rust nudger renders every live session's grid once a second with no dependence on the
// frontend being alive, classifies it (`src-tauri/src/observed_attention.rs`), and emits
// `attention://observed` WHEN THE VERDICT CHANGES. This module is the receiving half: it seeds from
// the pull command, listens for changes, and drops each reading into `runtimeStore`, where
// `engine/observedAttention` applies it to the row colour.
//
// ── WHY IT SEEDS AS WELL AS LISTENS, AND WHY THE ORDER IS THIS WAY ROUND ────────────────────────
// Emit-on-change means a listener that starts LATE has never seen a verdict — and the frontend
// starts late by construction, every launch and every reload. So the command is the channel and the
// event is the optimisation, the same shape `nudger.rs` uses for its flags.
//
// The LISTENER IS ARMED BEFORE THE SEED IS REQUESTED, deliberately. The other order has a hole
// exactly the width of the IPC round-trip: a verdict that changes during the seed would be emitted
// with nobody listening and then overwritten by the older snapshot, leaving the row wrong until the
// verdict happens to change AGAIN — which, for an agent parked at a prompt waiting for a human, is
// never. Arming first can only duplicate a reading, and the store's no-op guard swallows that.
//
// ── A BAD PAYLOAD COSTS ONE AGENT, NOT THE FEATURE ──────────────────────────────────────────────
// AGENTS.md records the measured incident this is written against: an all-or-nothing parser that
// rejects one field discards the WHOLE payload and silently falls back to its "we did not look"
// default, so the feature is inert permanently, for everyone, with nothing logged. Here a payload
// this side cannot read is counted and warned about ONCE, and every other agent keeps working.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { parseObservedReading, type ObservedReading } from "../engine/observedAttention";
import { useRuntimeStore } from "../stores/runtimeStore";
import { safeUnlisten } from "./safeUnlisten";

/** MUST match `observed_attention::OBSERVED_ATTENTION_EVENT` and the `event` key of
 *  `apps/desktop/shared/observed-attention.fixture.json`. Both suites pin it to that file. */
export const OBSERVED_ATTENTION_EVENT = "attention://observed";

/** The pull command that seeds a late listener. `observed_attention` in `lib.rs`'s handler. */
export const OBSERVED_ATTENTION_COMMAND = "observed_attention";

/** Singleton guard, mirroring `aiServiceHealthListener`: StrictMode and HMR both double-mount, and
 *  two listeners would apply every reading twice. Cleared on failure so a remount can re-arm. */
let startPromise: Promise<() => void> | undefined;

/** Warn once, not once per tick — a producer emitting a shape this side cannot read would otherwise
 *  fill the console at one line per agent per second and bury everything else. */
let warnedOnce = false;

function noteUnreadable(raw: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(
    "observed attention: dropped a payload this build cannot parse — the Rust producer and " +
      "apps/desktop/shared/observed-attention.fixture.json have drifted apart:",
    raw,
  );
}

/** Exported for tests: drop the singleton and the warn latch so each case arms its own. */
export function resetObservedAttentionListener(): void {
  startPromise = undefined;
  warnedOnce = false;
}

export function startObservedAttentionListener(): Promise<() => void> {
  startPromise ??= doStart().catch((e: unknown) => {
    startPromise = undefined;
    throw e;
  });
  return startPromise;
}

async function doStart(): Promise<() => void> {
  // Agents RETRACTED while the seed round-trip was in flight.
  //
  // A retraction is an ABSENCE, and absence is exactly what a spread cannot express: merging
  // `{ ...seed, ...live }` treats "arrived during the round-trip" as newer only for keys PRESENT in
  // `live`, so a `gone` handled between arming and the invoke resolving deletes the key — and then
  // the older snapshot puts it back. The producer has already dropped that agent, so no second
  // `gone` is ever emitted and the row sits red against a terminal that no longer exists,
  // permanently: the latched-reading defect, relocated into the seed path (roborev 67212).
  const retracted = new Set<string>();

  const unlisten = await listen(OBSERVED_ATTENTION_EVENT, (event) => {
    const parsed = parseObservedReading(event.payload);
    if (!parsed) {
      noteUnreadable(event.payload);
      return;
    }
    if (parsed.reading.verdict === "gone") {
      // A RETRACTION, not a reading. The agent's PTY is gone, so the row it described cannot be
      // asked about any more — hold on to the last verdict and a spun-down agent that was
      // `awaiting` stays red forever against a terminal that no longer exists.
      retracted.add(parsed.agentId);
      useRuntimeStore.getState().clearObservedAttention(parsed.agentId);
      return;
    }
    useRuntimeStore.getState().setObservedAttention(parsed.agentId, parsed.reading);
  });

  // Seed AFTER arming, per the header. A failure here is survivable — every agent whose verdict
  // changes from now on still lands — so it must not tear the listener down.
  try {
    const rows = await invoke<unknown[]>(OBSERVED_ATTENTION_COMMAND);
    const seed: Record<string, ObservedReading> = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      const parsed = parseObservedReading(row);
      if (!parsed) {
        noteUnreadable(row);
        continue;
      }
      // A snapshot never CONTAINS a retraction — `list()` returns live rows only — but a `gone` in
      // the seed would mean the producer changed and this build has not caught up. Skipping is the
      // safe reading either way: absent from the seed is exactly what `gone` asks for.
      if (parsed.reading.verdict === "gone") continue;
      seed[parsed.agentId] = parsed.reading;
    }
    // Drop anything retracted while we were waiting — see `retracted` above. This must happen
    // BEFORE the spread, because the row it removes is absent from `live` by construction and so
    // would otherwise be restored from the older snapshot.
    for (const id of retracted) delete seed[id];
    // Merge onto whatever the live listener already delivered rather than replacing it: a reading
    // that arrived during the round-trip is NEWER than the snapshot and must win.
    const live = useRuntimeStore.getState().observedAttention;
    useRuntimeStore.getState().seedObservedAttention({ ...seed, ...live });
  } catch {
    // No seed taken — the row keeps whatever the existing producers left it, which is exactly
    // today's behaviour. Silent because a missing command is the expected shape in a browser
    // harness and in every test that does not stub it.
  }

  return () => {
    // Through `safeUnlisten`, never bare — Tauri's real unlisten is ASYNC, so a bare call hands
    // back a rejected promise rather than throwing during a teardown race.
    void safeUnlisten(unlisten);
    startPromise = undefined;
  };
}
