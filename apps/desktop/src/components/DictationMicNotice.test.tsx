// @vitest-environment jsdom
//
// The quiet, mic-local half of the local-engine notice (sparkle-cbyhg). These assert what RENDERS —
// never a precondition the store already satisfied — and they are the UI end of the two guarantees
// the founder asked for: a transient outage raises NOTHING, and whatever is raised clears ITSELF.
//
// The store-level debounce is pinned in `stores/dictationEngineStore.transient.test.ts`. What is
// added here is the part only a DOM can answer: that the disappearance is a real unmount rather than
// a predicate flipping under a component nobody re-rendered.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationMicNotice, MIC_NOTICE } from "./DictationMicNotice";
import { DictationEngineBanner } from "./DictationEngineBanner";
import {
  FALLBACK_NOTICE_TTL_MS,
  UNAVAILABLE_FAILURES_BEFORE_NOTICE,
  UNAVAILABLE_SUSTAINED_MS,
  useDictationEngineStore,
} from "../stores/dictationEngineStore";

beforeEach(() =>
  useDictationEngineStore.setState({
    fallbackReason: null,
    dismissed: false,
    observedAt: null,
    openRefusals: 0,
    captureSession: 0,
    observedSession: null,
    unavailableSince: null,
  }),
);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Drive the REAL seam twice, far enough apart on a controlled clock to clear both halves of the
 *  debounce.
 *
 *  IT MOVES THE CLOCK RATHER THAN WRITING `unavailableSince`, and that is not a stylistic choice.
 *  An earlier version set the run-start stamp directly with `setState` — which is the "every test
 *  INJECTS THE SEAM" trap AGENTS.md names: `mutation-check` proved it, reporting the store line that
 *  actually takes that stamp (`unavailableSince: ambiguous ? …`) as UNCAUGHT, because no test here
 *  ever ran it. Deleting that line restored the one-failure alarm with this whole file still green.
 *  Advancing a faked clock makes the production path the only way the state can be reached. */
function sustainedOutage(): void {
  vi.useFakeTimers();
  const t0 = Date.now();
  act(() => {
    useDictationEngineStore.getState().noteCloudUnavailable("unavailable");
  });
  vi.setSystemTime(t0 + UNAVAILABLE_SUSTAINED_MS + 1);
  act(() => {
    useDictationEngineStore.getState().noteCloudUnavailable("unavailable");
  });
}

describe("DictationMicNotice", () => {
  it("renders nothing at rest", () => {
    const { container } = render(<DictationMicNotice />);
    expect(container.innerHTML).toBe("");
  });

  // ── THE HEADLINE REGRESSION, AT THE SURFACE ──────────────────────────────────────────────────
  // The founder's screenshot was one relay teardown wide. Nothing may appear for that.
  it("renders nothing for a single transient failure", () => {
    act(() => {
      useDictationEngineStore.getState().noteCloudUnavailable("unavailable");
    });
    const { container } = render(<DictationMicNotice />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  // THE PAIR, without which the case above passes against a component that never renders anything.
  it("renders the caption once the outage is corroborated and sustained", () => {
    sustainedOutage();
    const { container } = render(<DictationMicNotice />);
    expect(container.innerHTML).not.toBe("");
    expect(screen.getByRole("status").textContent ?? "").toContain(MIC_NOTICE);
  });

  // ── AUTO-DISMISS: THE SIDE EFFECT, NOT THE FLAG ──────────────────────────────────────────────
  // "He should never have to click the X on a condition that already healed." There is no ✕ here at
  // all, so the only way this can be true is if recovery removes it from the DOM by itself.
  it("clears itself from the DOM the moment the relay reconnects", () => {
    sustainedOutage();
    const { container } = render(<DictationMicNotice />);
    expect(container.innerHTML).not.toBe("");

    act(() => useDictationEngineStore.getState().noteCloudLive());

    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  // The other way a self-healing condition ends: nobody re-reported it and it aged out. This is what
  // proves the retire TIMER is armed from THIS component — before the surface split, the only thing
  // arming it was DictationEngineBanner, which no longer renders this reason at all.
  it("takes itself down on the TTL without a banner mounted anywhere", () => {
    // `sustainedOutage` already installs fake timers — it has to, to advance across the debounce.
    sustainedOutage();
    const { container } = render(<DictationMicNotice />);
    expect(container.innerHTML).not.toBe("");

    act(() => void vi.advanceTimersByTime(FALLBACK_NOTICE_TTL_MS + 1000));

    expect(container.innerHTML).toBe("");
    expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
  });

  // It offers no dismiss control, deliberately — see the component header. A ✕ here would be work
  // the user does not have to do.
  it("offers no dismiss button — the condition clears without the user", () => {
    sustainedOutage();
    render(<DictationMicNotice />);
    expect(screen.queryByLabelText("Dismiss")).toBeNull();
  });

  it("uses a react-icons glyph, never an emoji", () => {
    // Standing founder rule: no emoji as icons anywhere in the product.
    sustainedOutage();
    const { container } = render(<DictationMicNotice />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });

  // ── COPY RULES, inherited from the banner's header ───────────────────────────────────────────
  it("carries no raw error, status code, or false blame", () => {
    expect(MIC_NOTICE).not.toMatch(/HTTP \d|\b4\d\d\b|\b5\d\d\b|websocket|deepgram|sherpa|@/i);
    expect(MIC_NOTICE).not.toMatch(/your network|you're offline|you are offline|Claude|rate.?limit/i);
    // The two facts a user needs, and the reason the notice exists at all.
    expect(MIC_NOTICE).toMatch(/preview off/i);
    expect(MIC_NOTICE).toMatch(/still captured/i);
  });

  // It must not tell the user to retry: by the time this paints, the relay has been unreachable for
  // over twenty seconds across repeated attempts, and the next dictation retries on its own. This is
  // the AGENTS.md remedy-unsafe-under-its-own-trigger rule applied to the shorter copy.
  it("does not hand the user a retry they cannot usefully perform", () => {
    expect(MIC_NOTICE).not.toMatch(/try again|try dictating again/i);
  });

  // ── THE TWO SURFACES ARE MUTUALLY EXCLUSIVE ─────────────────────────────────────────────────
  // Both read the same store, so the one thing that must never happen is BOTH painting for one
  // condition — which is exactly what a component still asking `shouldWarnLocalEngine` would do.
  it("never paints at the same time as the window-wide banner", () => {
    sustainedOutage();
    const mic = render(<DictationMicNotice />);
    expect(mic.container.innerHTML).not.toBe("");

    const banner = render(<DictationEngineBanner />);
    expect(banner.container.innerHTML).toBe("");
  });

  it("…and yields to the banner for a reason the user must act on", () => {
    act(() => useDictationEngineStore.getState().noteCloudUnavailable("exhausted"));

    const mic = render(<DictationMicNotice />);
    expect(mic.container.innerHTML).toBe("");

    const banner = render(<DictationEngineBanner />);
    expect(banner.container.innerHTML).not.toBe("");
  });

  // A sanity check on the constant the whole debounce is expressed in: a threshold of 1 would make
  // every case above vacuous, and a zero-length window would defeat the duration gate entirely.
  it("is debounced by a threshold that could actually reject a blip", () => {
    expect(UNAVAILABLE_FAILURES_BEFORE_NOTICE).toBeGreaterThan(1);
    expect(UNAVAILABLE_SUSTAINED_MS).toBeGreaterThanOrEqual(10_000);
  });
});
