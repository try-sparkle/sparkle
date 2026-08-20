// THE EMPIRICAL ZERO-SPEND LATCH — persisted, because a finding that dies with the tab is not a
// finding.
//
// The spend gate permits a call only while `extra_usage.is_enabled` is FALSE, on the premise that a
// disarmed credit meter has no billable destination. Nobody has established which meter advisor
// usage actually hits. So the first gate-approved call is MEASURED: `used_credits` immediately
// before, `used_credits` immediately after. If it moved, the premise failed its own test and the
// advisor latches itself OFF until a human clears it.
//
// ══ WHY LOCALSTORAGE AND NOT A MODULE FLAG ══════════════════════════════════════════════════════
//
// A module flag is cleared by every reload, so a latched advisor would resume dispatching the moment
// the window refreshed — which is to say the latch would only ever hold for the length of one
// session, and the movement it observed would be re-observed (and re-billed) on the next. The whole
// value of latching is that it is STICKY. `localStorage` is the same store `services/models.ts` uses
// for its catalog cache, so this adds no new persistence mechanism.
//
// The DURABLE record is still the bead comment `pass.ts` writes — this is only the switch.
import { log } from "../../logger";
import type { AdvisorLatch } from "./pass";

const LS_LATCHED = "sparkle.advisor.latched.v1";
const LS_CREDITS_BEFORE = "sparkle.advisor.creditsBefore.v1";
const LS_MEASURED = "sparkle.advisor.measured.v1";

/** Reads that cannot throw. `localStorage` is unavailable in some webview contexts and in a
 *  non-DOM test environment, and an advisor that crashed on a missing storage API would be a worse
 *  failure than the one it is guarding. */
function readItem(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    // A latch that cannot be persisted still holds for this session (the module cache below), and
    // saying so is more useful than throwing out of a fire-and-forget path.
    log.warn("advisor", "could not persist the advisor latch", { key });
  }
}

// Module cache in front of the store, so a latched advisor stays latched for THIS session even when
// `localStorage` is unavailable or refused the write.
let latchedThisSession = false;

/** The production latch. */
export const productionLatch: AdvisorLatch = {
  isLatched: () => latchedThisSession || readItem(LS_LATCHED) === "1",
  latch: (reason: string) => {
    latchedThisSession = true;
    writeItem(LS_LATCHED, "1");
    // LOUD. This is the one event in the whole feature that means a founder-level constraint may
    // have been violated, and it must not be discoverable only by reading a bead.
    log.error("advisor", "ADVISOR LATCHED OFF — the credit meter moved on a gate-approved call", {
      reason,
    });
  },
  creditsBefore: () => {
    const raw = readItem(LS_CREDITS_BEFORE);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  },
  recordCreditsBefore: (value: number | null) => {
    // Only the FIRST approved call's reading. A later call must not re-baseline: the measurement is
    // of the first call, and re-baselining every pass would make a slow drift permanently invisible
    // — each pass would compare against a number that already included the previous pass's spend.
    if (readItem(LS_CREDITS_BEFORE) !== null) return;
    if (value === null) return;
    writeItem(LS_CREDITS_BEFORE, String(value));
  },
  measured: () => readItem(LS_MEASURED) === "1",
  markMeasured: () => writeItem(LS_MEASURED, "1"),
};

/** Test seam / operator escape hatch: clear the latch and its measurement. Exported so a human can
 *  reach it from the devtools console after investigating a latch — there is deliberately no UI
 *  control, because clearing it without establishing WHY the meter moved is exactly the action the
 *  latch exists to prevent someone taking casually. */
export function clearAdvisorLatch(): void {
  latchedThisSession = false;
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(LS_LATCHED);
    localStorage.removeItem(LS_CREDITS_BEFORE);
    localStorage.removeItem(LS_MEASURED);
  } catch {
    // nothing to do — the session cache above is already cleared
  }
}
