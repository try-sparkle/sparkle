// @vitest-environment jsdom
//
// The sticky strip. Its whole reason to exist is OUTLIVING the turn that produced it — the thinking
// indicator vanishes the moment a turn is no longer in flight, which is exactly when a dead turn
// stops being visible. So most of these cases are about what it still says after the turn is gone.
//
// SCOPE, after the 2026-07-30 colour-only retune: it speaks for ERRORS THE APP RECEIVED and for
// nothing else. Silence lost its words entirely and is now said by the thinking indicator's ink, so
// the cases that matter most here are the ones proving no amount of quiet reaches this component.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONCIERGE_UNAVAILABLE_EVIDENCE_TESTID,
  CONCIERGE_UNAVAILABLE_TESTID,
  ConciergeUnavailable,
} from "./ConciergeUnavailable";
import { QUOTA_FAILURE_HEADLINE } from "../../engine/conciergeFailureNotice";
import {
  FAILURE_OUTAGE_RUN,
  SLOW_AFTER_MS,
  STALLED_AFTER_MS,
  STALLED_SILENT_RUN,
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

  // THE PATH A REAL OUTAGE TAKES, and the one this component still exists for. Every failure observed
  // in a day of logs was a fast, loud error, so this state is reached with ZERO silent seconds — no
  // timers are advanced in this case at all.
  it("appears after a run of hard failures and states the reason verbatim", () => {
    failTimes(FAILURE_OUTAGE_RUN);
    render(<ConciergeUnavailable />);
    expect(strip()).not.toBeNull();
    expect(strip()?.textContent).toContain(QUOTA_FAILURE_HEADLINE);
    expect(screen.getByTestId(CONCIERGE_UNAVAILABLE_EVIDENCE_TESTID).textContent).toBe(QUOTA);
  });

  it("does not appear for a single failure", () => {
    failTimes(1);
    render(<ConciergeUnavailable />);
    expect(strip()).toBeNull();
  });

  // ── SILENCE NEVER REACHES THIS COMPONENT ──────────────────────────────────────────────────────
  //
  // *"Don't have it say no answer yet, just have the color change."* A slow turn is stated by the
  // thinking indicator's ink and by nothing else; there is no degree of quiet that puts a sentence
  // above the compose box.
  it("stays out of the way for a slow turn", () => {
    noteConciergeSent();
    const { rerender } = render(<ConciergeUnavailable />);
    vi.advanceTimersByTime(SLOW_AFTER_MS);
    rerender(<ConciergeUnavailable />);
    expect(strip()).toBeNull();
  });

  it("stays out of the way for a turn that has gone fully red, and stays out indefinitely", () => {
    noteConciergeSent();
    const { rerender } = render(<ConciergeUnavailable />);
    vi.advanceTimersByTime(STALLED_AFTER_MS * 10);
    rerender(<ConciergeUnavailable />);
    expect(strip()).toBeNull();
  });

  // THE STALE-REASON ROW (roborev 55468-M1 / 55442-M4), which the retune closes by construction
  // rather than by derivation. An old quota rejection is still in state — the notice deliberately
  // outlives its turn, because clearing it on send would break the failure run — and the user has
  // since re-sent repeatedly into a void. Rendering it here would put "resets 8:40am" on screen at
  // 2pm as the stated reason the concierge is quiet NOW: a real limit, long expired, presented as
  // the current cause. With silence unable to reach this component at all, there is no route by
  // which that can happen.
  it("never resurrects a stale earlier failure when the concierge has merely gone quiet", () => {
    failTimes(1);
    noteConciergeSent();
    for (let i = 0; i < STALLED_SILENT_RUN; i += 1) {
      vi.advanceTimersByTime(SLOW_AFTER_MS + 1_000);
      noteConciergeSent();
    }
    render(<ConciergeUnavailable />);

    expect(strip()).toBeNull();
    // The two halves of the lie, pinned separately: neither the quota headline nor its evidence.
    expect(document.body.textContent).not.toContain(QUOTA_FAILURE_HEADLINE);
    expect(document.body.textContent).not.toContain("resets 8:40am");
  });

  // "Recovering must clear the state promptly." One sign of life is enough — the user does not have
  // to wait out a cooldown to stop being told their concierge is dead.
  it("clears the moment anything comes back", () => {
    failTimes(FAILURE_OUTAGE_RUN);
    const { rerender } = render(<ConciergeUnavailable />);
    expect(strip()).not.toBeNull();

    noteConciergeProgress("text");
    rerender(<ConciergeUnavailable />);
    expect(strip()).toBeNull();
  });

  // STICKY: the state has to survive the next send, or a user who re-sends into a dead concierge
  // watches the warning disappear and is back to the silence this feature exists to end.
  it("survives the user sending again", () => {
    failTimes(FAILURE_OUTAGE_RUN);
    const { rerender } = render(<ConciergeUnavailable />);
    noteConciergeSent();
    rerender(<ConciergeUnavailable />);
    expect(strip()).not.toBeNull();
  });

  // The column has exactly ONE live region, mounted with it and fed through `announce`. A second one
  // is forbidden by convention in six file headers — and a region inserted into the DOM together
  // with its text is not announced anyway.
  it("adds no second live region to the column", () => {
    failTimes(FAILURE_OUTAGE_RUN);
    render(<ConciergeUnavailable />);
    expect(strip()?.querySelector("[aria-live]")).toBeNull();
    expect(strip()?.getAttribute("aria-live")).toBeNull();
  });
});
