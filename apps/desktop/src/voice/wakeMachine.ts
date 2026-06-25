// Pure phase state machine for the always-listening loop. Given the current phase
// and one closed VAD transcript segment, returns the next phase and any text to
// insert into the prompt box. Cooldown/timing is the caller's concern (kept impure).
import {
  matchesWake,
  matchesStop,
  stripWakePrefix,
  stripStopSuffix,
} from "./wakeWords";

export type Phase = "passive" | "active";

export interface Advance {
  phase: Phase;
  /** Text to append to the active composer, or null for nothing. */
  insert: string | null;
  /** True when this segment changed the phase (used for cooldown by the caller). */
  transitioned: boolean;
}

export function advance(phase: Phase, segment: string): Advance {
  if (phase === "passive") {
    if (matchesWake(segment)) {
      const remainder = stripWakePrefix(segment).trim();
      return { phase: "active", insert: remainder || null, transitioned: true };
    }
    return { phase: "passive", insert: null, transitioned: false };
  }
  // active
  if (matchesStop(segment)) {
    const remainder = stripStopSuffix(segment).trim();
    return { phase: "passive", insert: remainder || null, transitioned: true };
  }
  return { phase: "active", insert: segment.trim() || null, transitioned: false };
}
