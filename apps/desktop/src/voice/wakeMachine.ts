// Pure phase state machine for the always-listening loop. Given the current phase
// and one closed VAD transcript segment, returns the next phase and any text to
// insert into the prompt box. Cooldown/timing is the caller's concern (kept impure).
import {
  matchesWake,
  matchesStop,
  stripWakePrefix,
  stripStopSuffix,
  DEFAULT_WAKE_CONFIG,
  type WakeConfig,
} from "./wakeWords";

export type Phase = "passive" | "active";

export interface Advance {
  phase: Phase;
  /** Text to append to the active composer, or null for nothing. */
  insert: string | null;
  /** True when this segment changed the phase (used for cooldown by the caller). */
  transitioned: boolean;
}

export function advance(
  phase: Phase,
  segment: string,
  config: WakeConfig = DEFAULT_WAKE_CONFIG,
): Advance {
  if (phase === "passive") {
    if (matchesWake(segment, config)) {
      const remainder = stripWakePrefix(segment, config).trim();
      return { phase: "active", insert: remainder || null, transitioned: true };
    }
    return { phase: "passive", insert: null, transitioned: false };
  }
  // active
  if (matchesStop(segment, config)) {
    const remainder = stripStopSuffix(segment, config).trim();
    return { phase: "passive", insert: remainder || null, transitioned: true };
  }
  return { phase: "active", insert: segment.trim() || null, transitioned: false };
}
