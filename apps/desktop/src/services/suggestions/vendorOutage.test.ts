import { describe, it, expect } from "vitest";
import {
  NO_OUTAGE,
  OUTAGE_COOLDOWN_MS,
  OUTAGE_PROBE_TIMEOUT_MS,
  OUTAGE_THRESHOLD,
  claimProbe,
  isOutageOpen,
  isVendorOutageError,
  noteFailure,
  noteSuccess,
  outageCooldownRemainingMs,
  probeWaitMs,
  releaseProbe,
} from "./vendorOutage";

const T0 = 1_000_000;

/** Fold n identical rejections in at the same instant, from a closed breaker. */
function failTimes(n: number, message: string, now = T0) {
  let s = NO_OUTAGE;
  for (let i = 0; i < n; i += 1) s = noteFailure(s, message, now);
  return s;
}

describe("isVendorOutageError", () => {
  it("counts the 5xx class the proxy surfaces as (HTTP nnn)", () => {
    for (const code of [500, 502, 503, 504, 529, 599]) {
      expect(isVendorOutageError(`ai request failed (HTTP ${code})`)).toBe(true);
    }
  });

  it("does not count 4xx — those are per-request, and already terminal or backed off", () => {
    // 408/429 are 'retry this request later'; they say nothing about the vendor being down for
    // OTHER agents, which is the only thing a shared breaker may act on.
    for (const code of [400, 401, 403, 404, 408, 429]) {
      expect(isVendorOutageError(`ai request failed (HTTP ${code})`)).toBe(false);
    }
  });

  it("does not count a message with no HTTP status at all", () => {
    expect(isVendorOutageError("ai backend unavailable")).toBe(false);
    expect(isVendorOutageError("")).toBe(false);
  });

  it("does not read a bare number as a status", () => {
    // Only the parenthesized form the proxy emits counts, so scrollback or vendor prose that
    // happens to contain '502' cannot trip a cooldown for every agent.
    expect(isVendorOutageError("upstream returned 502 for the request")).toBe(false);
  });
});

describe("noteFailure", () => {
  it("stays closed below the threshold — a lone blip keeps its normal retry", () => {
    const s = failTimes(OUTAGE_THRESHOLD - 1, "ai request failed (HTTP 502)");
    expect(s.openedAt).toBeNull();
    expect(isOutageOpen(s, T0)).toBe(false);
  });

  it("opens on the threshold-th consecutive vendor outage", () => {
    const s = failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)");
    expect(s.openedAt).toBe(T0);
    expect(isOutageOpen(s, T0)).toBe(true);
  });

  it("resets the run on a non-outage rejection, so a 4xx can't accumulate toward a cooldown", () => {
    let s = failTimes(OUTAGE_THRESHOLD - 1, "ai request failed (HTTP 502)");
    s = noteFailure(s, "ai request failed (HTTP 400)", T0);
    expect(s.consecutive).toBe(0);
    s = noteFailure(s, "ai request failed (HTTP 502)", T0);
    expect(s.openedAt).toBeNull();
  });

  it("does not close an OPEN breaker on a non-outage rejection — only a success proves recovery", () => {
    let s = failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)");
    s = noteFailure(s, "ai request failed (HTTP 400)", T0 + 1);
    expect(isOutageOpen(s, T0 + 1)).toBe(true);
  });

  it("a failing probe cannot extend an open cooldown by re-stamping openedAt", () => {
    // Otherwise a long episode would hold the breaker open forever and the half-open probe that
    // detects recovery would never run.
    let s = failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)");
    s = noteFailure(s, "ai request failed (HTTP 502)", T0 + 1_000);
    expect(s.openedAt).toBe(T0);
  });

  it("re-opens from the probe's instant once the cooldown has elapsed", () => {
    const s = failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)");
    const later = T0 + OUTAGE_COOLDOWN_MS + 1;
    expect(isOutageOpen(s, later)).toBe(false);
    const reopened = noteFailure(s, "ai request failed (HTTP 503)", later);
    expect(reopened.openedAt).toBe(later);
    expect(isOutageOpen(reopened, later)).toBe(true);
  });
});

describe("isOutageOpen / outageCooldownRemainingMs", () => {
  it("a closed breaker is open for nobody and schedules no wake", () => {
    expect(isOutageOpen(NO_OUTAGE, T0)).toBe(false);
    expect(outageCooldownRemainingMs(NO_OUTAGE, T0)).toBe(0);
  });

  it("reports the remaining cooldown, which is what the caller's wake timer runs on", () => {
    const s = failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)");
    expect(outageCooldownRemainingMs(s, T0)).toBe(OUTAGE_COOLDOWN_MS);
    expect(outageCooldownRemainingMs(s, T0 + 20_000)).toBe(OUTAGE_COOLDOWN_MS - 20_000);
  });

  it("closes exactly at expiry, never reporting a negative wake", () => {
    const s = failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)");
    expect(isOutageOpen(s, T0 + OUTAGE_COOLDOWN_MS)).toBe(false);
    expect(outageCooldownRemainingMs(s, T0 + OUTAGE_COOLDOWN_MS * 2)).toBe(0);
  });
});

describe("noteSuccess", () => {
  it("closes the breaker and clears the run", () => {
    expect(noteSuccess()).toEqual(NO_OUTAGE);
    expect(isOutageOpen(noteSuccess(), T0)).toBe(false);
  });
});

describe("claimProbe — one probe per cooldown, not one per mounted pane", () => {
  /** The instant the cooldown elapses, at which every pane's gate flips to half-open together. */
  const EXPIRY = T0 + OUTAGE_COOLDOWN_MS;

  it("grants unconditionally while the breaker has never tripped", () => {
    // Healthy computes for different agents are independent work; serialising them would make
    // suggestions arrive one pane at a time for no benefit.
    const a = claimProbe(NO_OUTAGE, T0);
    expect(a.granted).toBe(true);
    expect(claimProbe(a.state, T0).granted).toBe(true);
    expect(a.state.probeStartedAt).toBeNull();
  });

  it("admits exactly ONE caller at a cooldown expiry, and denies the rest of the herd", () => {
    // This is the defect: isOutageOpen is a pure time check with no notion of who is asking, so a
    // burst of panes all read half-open at the same instant and each issued its own paid call.
    let s = failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)");
    expect(isOutageOpen(s, EXPIRY)).toBe(false); // half-open for everyone at once

    let granted = 0;
    for (let pane = 0; pane < 20; pane += 1) {
      const claim = claimProbe(s, EXPIRY);
      s = claim.state;
      if (claim.granted) granted += 1;
    }
    expect(granted).toBe(1);
  });

  it("denied callers are handed a wake that expires with the live probe, so they can't strand", () => {
    const s = claimProbe(failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)"), EXPIRY).state;
    expect(probeWaitMs(s, EXPIRY)).toBe(OUTAGE_PROBE_TIMEOUT_MS);
    expect(probeWaitMs(s, EXPIRY + 1_000)).toBe(OUTAGE_PROBE_TIMEOUT_MS - 1_000);
    // Never negative, and nothing to wait for once no probe is live.
    expect(probeWaitMs(s, EXPIRY + OUTAGE_PROBE_TIMEOUT_MS * 2)).toBe(0);
    expect(probeWaitMs(NO_OUTAGE, T0)).toBe(0);
  });

  it("a probe that never settles ages out, so an unmounted pane can't wedge the breaker shut", () => {
    const s = claimProbe(failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)"), EXPIRY).state;
    expect(claimProbe(s, EXPIRY + OUTAGE_PROBE_TIMEOUT_MS - 1).granted).toBe(false);
    expect(claimProbe(s, EXPIRY + OUTAGE_PROBE_TIMEOUT_MS).granted).toBe(true);
  });

  it("every settlement releases the claim, so the NEXT cooldown gets its own probe", () => {
    // A failing probe re-opens the breaker; the claim must not survive into that new window, or the
    // next expiry would be blocked behind a call that already landed.
    const held = claimProbe(failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)"), EXPIRY)
      .state;
    expect(held.probeStartedAt).toBe(EXPIRY);

    const reopened = noteFailure(held, "ai request failed (HTTP 502)", EXPIRY);
    expect(reopened.probeStartedAt).toBeNull();
    expect(claimProbe(reopened, EXPIRY + OUTAGE_COOLDOWN_MS).granted).toBe(true);

    // Non-outage rejection and success settle it too.
    expect(noteFailure(held, "ai request failed (HTTP 400)", EXPIRY).probeStartedAt).toBeNull();
    expect(noteSuccess().probeStartedAt).toBeNull();
  });

  it("releaseProbe hands the claim back without voting on the vendor's health", () => {
    // The deferral path (offline / out-of-credits) returns before noteFailure on purpose: a shut
    // LOCAL gate is not evidence the vendor is down. It still has to return the claim.
    const held = claimProbe(failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)"), EXPIRY)
      .state;
    const released = releaseProbe(held);
    expect(released.probeStartedAt).toBeNull();
    expect(released.consecutive).toBe(held.consecutive);
    expect(released.openedAt).toBe(held.openedAt);
    expect(claimProbe(released, EXPIRY).granted).toBe(true);
    // A no-op when nothing is held, so it can't manufacture a state change.
    expect(releaseProbe(NO_OUTAGE)).toBe(NO_OUTAGE);
  });

  it("costs ONE call per cooldown across a whole pane fleet, not one per pane", () => {
    // The measured shape of the defect: sawtooth bursts of tens of rejections at each expiry.
    // With the claim, a 10-minute episode across 20 panes costs one call per cooldown.
    let s = NO_OUTAGE;
    let calls = 0;
    for (let tick = 0; tick <= 10 * OUTAGE_COOLDOWN_MS; tick += 1_000) {
      const now = T0 + tick;
      for (let pane = 0; pane < 20; pane += 1) {
        if (isOutageOpen(s, now)) continue;
        const claim = claimProbe(s, now);
        s = claim.state;
        if (!claim.granted) continue;
        calls += 1;
        s = noteFailure(s, "ai request failed (HTTP 502)", now); // the vendor is still down
      }
    }
    // OUTAGE_THRESHOLD calls to trip the breaker, then one probe per elapsed cooldown.
    expect(calls).toBe(OUTAGE_THRESHOLD + 10);
  });
});

describe("the episode this exists for", () => {
  it("declines the first call of every NEW state while open — the volume the retry budget misses", () => {
    // The per-state budget only ever dampens retries of a state it has already seen fail; each new
    // settled state arrives with a full budget. Once open, the breaker declines them all.
    let s = failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)");
    let declined = 0;
    for (let i = 1; i <= 40; i += 1) {
      const now = T0 + i * 1_000; // ~40 fresh settled states over the next minute
      if (isOutageOpen(s, now)) {
        declined += 1;
        continue;
      }
      s = noteFailure(s, "ai request failed (HTTP 502)", now);
    }
    expect(declined).toBe(40);
  });

  it("recovers on the first probe that succeeds after the cooldown", () => {
    const s = failTimes(OUTAGE_THRESHOLD, "ai request failed (HTTP 502)");
    const later = T0 + OUTAGE_COOLDOWN_MS;
    expect(isOutageOpen(s, later)).toBe(false); // probe is allowed through
    expect(isOutageOpen(noteSuccess(), later)).toBe(false); // and it closes the breaker
  });
});
