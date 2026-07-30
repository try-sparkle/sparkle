// @vitest-environment jsdom
//
// The sticky strip. Its whole reason to exist is OUTLIVING the turn that produced it — the thinking
// indicator vanishes the moment a turn is no longer in flight, which is exactly when a dead turn
// stops being visible. So most of these cases are about what it still says after the turn is gone.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONCIERGE_UNAVAILABLE_EVIDENCE_TESTID,
  CONCIERGE_UNAVAILABLE_TESTID,
  ConciergeUnavailable,
  UNAVAILABLE_SILENT_HEADLINE,
} from "./ConciergeUnavailable";
import { QUOTA_FAILURE_HEADLINE } from "../../engine/conciergeFailureNotice";
import {
  OFFLINE_AFTER_MS,
  UNAVAILABLE_AFTER_MS,
  UNAVAILABLE_FAILURE_RUN,
  UNAVAILABLE_SILENT_RUN,
} from "../../engine/conciergeLiveness";
import {
  _resetConciergeLivenessForTests,
  noteConciergeFailed,
  noteConciergeProgress,
  noteConciergeSent,
} from "../../services/conciergeLiveness";

const QUOTA = "You've hit your session limit · resets 8:40am (America/Bogota)";

beforeEach(() => {
  vi.useFakeTimers();
  _resetConciergeLivenessForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const strip = () => screen.queryByTestId(CONCIERGE_UNAVAILABLE_TESTID);

/** Fail `n` turns in a row, the way six consecutive spend-limit rejections did on 2026-07-29. */
function failTimes(n: number, detail = QUOTA) {
  for (let i = 0; i < n; i += 1) noteConciergeFailed(detail);
}

describe("ConciergeUnavailable", () => {
  it("renders nothing while the concierge is behaving", () => {
    render(<ConciergeUnavailable />);
    expect(strip()).toBeNull();
  });

  // OFFLINE is transient by design — the turn may still answer, and the thinking indicator is
  // already saying so inside the scroller. A strip that appeared and vanished on every slow-ish turn
  // would train the user to ignore the one that matters.
  it("stays out of the way for a merely slow turn", () => {
    noteConciergeSent();
    const { rerender } = render(<ConciergeUnavailable />);
    vi.advanceTimersByTime(UNAVAILABLE_AFTER_MS - 2_000);
    rerender(<ConciergeUnavailable />);
    expect(strip()).toBeNull();
  });

  it("appears once silence passes the unavailable bound", () => {
    noteConciergeSent();
    const { rerender } = render(<ConciergeUnavailable />);
    vi.advanceTimersByTime(UNAVAILABLE_AFTER_MS);
    rerender(<ConciergeUnavailable />);
    expect(strip()).not.toBeNull();
    // No error arrived, so it says only what was OBSERVED. "Your concierge crashed" and "Claude is
    // down" are both diagnoses this app cannot make from silence.
    expect(strip()?.textContent).toContain(UNAVAILABLE_SILENT_HEADLINE);
  });

  // THE PATH A REAL OUTAGE TAKES. Every failure observed in a day of logs was a fast, loud error, so
  // this state is reached with ZERO silent seconds — no timers are advanced in this case at all.
  it("appears after a run of hard failures and states the reason verbatim", () => {
    failTimes(UNAVAILABLE_FAILURE_RUN);
    render(<ConciergeUnavailable />);
    expect(strip()).not.toBeNull();
    expect(strip()?.textContent).toContain(QUOTA_FAILURE_HEADLINE);
    expect(screen.getByTestId(CONCIERGE_UNAVAILABLE_EVIDENCE_TESTID).textContent).toBe(QUOTA);
  });

  // THE STALE-REASON ROW (roborev 55468-M1). The two cases above cannot see the bug they look like
  // they cover: the silence case reaches UNAVAILABLE with `failure === null`, and the failure case
  // reaches it via the failure route — so both render identically whether the component consults
  // `reason` or just asks "is there a failure lying around?".
  //
  // This is the case where those two answers DIVERGE. An old quota rejection is still in state (the
  // notice deliberately outlives its turn), but what made the concierge unavailable THIS time is
  // silence — the user re-sent three times into a void. Reading `failure` directly here puts
  // "resets 8:40am" on screen at 2pm as the stated reason the concierge is quiet, which is the exact
  // lie the reason-derivation exists to prevent: a real limit, long expired, presented as the
  // current cause. `livenessReason`'s engine tests prove the derivation; only this proves the strip
  // consults it.
  it("blames silence, not a stale earlier failure, when silence is what got us here", () => {
    failTimes(1);
    noteConciergeSent();
    for (let i = 0; i < UNAVAILABLE_SILENT_RUN; i += 1) {
      vi.advanceTimersByTime(OFFLINE_AFTER_MS);
      noteConciergeSent();
    }
    render(<ConciergeUnavailable />);

    expect(strip()).not.toBeNull();
    expect(strip()?.textContent).toContain(UNAVAILABLE_SILENT_HEADLINE);
    // The two halves of the lie, pinned separately: neither the quota headline nor its evidence.
    expect(strip()?.textContent).not.toContain(QUOTA_FAILURE_HEADLINE);
    expect(strip()?.textContent).not.toContain("resets 8:40am");
    expect(screen.queryByTestId(CONCIERGE_UNAVAILABLE_EVIDENCE_TESTID)).toBeNull();
  });

  it("does not appear for a single failure", () => {
    failTimes(1);
    render(<ConciergeUnavailable />);
    expect(strip()).toBeNull();
  });

  // "Recovering must clear the state promptly." One sign of life is enough — the user does not have
  // to wait out a cooldown to stop being told their concierge is dead.
  it("clears the moment anything comes back", () => {
    failTimes(UNAVAILABLE_FAILURE_RUN);
    const { rerender } = render(<ConciergeUnavailable />);
    expect(strip()).not.toBeNull();

    noteConciergeProgress("text");
    rerender(<ConciergeUnavailable />);
    expect(strip()).toBeNull();
  });

  // STICKY: the state has to survive the next send, or a user who re-sends into a dead concierge
  // watches the warning disappear and is back to the silence this feature exists to end.
  it("survives the user sending again", () => {
    failTimes(UNAVAILABLE_FAILURE_RUN);
    const { rerender } = render(<ConciergeUnavailable />);
    noteConciergeSent();
    rerender(<ConciergeUnavailable />);
    expect(strip()).not.toBeNull();
  });

  // The column has exactly ONE live region, mounted with it and fed through `announce`. A second one
  // is forbidden by convention in six file headers — and a region inserted into the DOM together
  // with its text is not announced anyway.
  it("adds no second live region to the column", () => {
    failTimes(UNAVAILABLE_FAILURE_RUN);
    render(<ConciergeUnavailable />);
    expect(strip()?.querySelector("[aria-live]")).toBeNull();
    expect(strip()?.getAttribute("aria-live")).toBeNull();
  });
});
