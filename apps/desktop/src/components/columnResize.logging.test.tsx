// @vitest-environment jsdom
//
// THE LOG LINES THEMSELVES, ASSERTED.
//
// The whole premise of this series is "a resize that goes nowhere must say so in the log" — and
// until this file existed, nothing anywhere asserted that any component ever called the logger.
// `clampWidth` was unit-tested, but you could delete every `log.info` from both boundaries and the
// entire suite stayed green. That is the "assertion was already true before the change" shape
// AGENTS.md names as the #1 fleet-wide finding, and it had landed in the same commit that deleted
// other code for exactly that reason.
//
// So these assert the SIDE EFFECT — what reached the logger — and never that a clamp helper returned
// the right number, which is `columnResize.test.ts`'s job.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// `vi.hoisted` because the `vi.mock` factory below is lifted above every top-level binding.
const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../logger", () => ({ log: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { ColumnPullTab } from "./ColumnPullTab";

/** Every `resize`-scoped line emitted so far, joined for substring matching. */
const lines = () =>
  info.mock.calls.filter((c) => c[0] === "resize").map((c) => String(c[1]));

beforeEach(() => {
  info.mockClear();
});
afterEach(() => cleanup());

function mountTab(width = 360, min = 280, max = 560) {
  const onWidth = vi.fn();
  render(
    <ColumnPullTab
      width={width}
      onWidth={onWidth}
      min={min}
      max={max}
      label="Sparkle column"
      testId="tab"
    />,
  );
  return { onWidth };
}

const dots = () => screen.getByTestId("tab-dots");

describe("the drag says what it did", () => {
  it("brackets the gesture — a start line and an end line", () => {
    mountTab();
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 520, buttons: 1 });
    fireEvent.mouseUp(window, { clientX: 520 });

    expect(lines().some((l) => l.includes("drag start at 360px"))).toBe(true);
    expect(lines().some((l) => l.includes("drag end (release)"))).toBe(true);
  });

  it("names the bound when the drag goes nowhere — the line the report needed", () => {
    // "Registers but does not resize", diagnosable from the log alone.
    mountTab();
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 5000, buttons: 1 });
    expect(lines().some((l) => l.includes("clamped by max"))).toBe(true);
    expect(lines().some((l) => l.includes("applied 560"))).toBe(true);
  });

  it("says so when the release went missing rather than reporting a clean end", () => {
    // A lost mouseup and an ordinary release are different failures; the log must tell them apart.
    mountTab();
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 520, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 540, buttons: 0 });
    expect(lines().some((l) => l.includes("drag end (release-lost)"))).toBe(true);
  });

  it("logs a pinned drag ONCE, not once per pointer event", () => {
    // Edge-triggered because every forwarded line costs a synchronous IPC → disk write on the main
    // thread. Instrumenting a drag must not become its own source of jank.
    mountTab();
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500, buttons: 1 });
    for (const x of [5000, 5100, 5200, 5300, 5400]) {
      fireEvent.mouseMove(window, { clientX: x, buttons: 1 });
    }
    expect(lines().filter((l) => l.includes("clamped by max"))).toHaveLength(1);
  });
});

describe("the keyboard path is not silent", () => {
  it("logs an arrow nudge that moves the boundary", () => {
    mountTab();
    fireEvent.keyDown(dots(), { key: "ArrowRight" });
    expect(lines().some((l) => l.includes("unclamped"))).toBe(true);
  });

  it("still logs an arrow AFTER a drag that ended pinned at the same bound", () => {
    // THE REGRESSION THE RESET FIXES. `lastClamp` survives the drag, so without it the keyed nudge
    // that follows a pinned drag emits nothing at all — the reported symptom, in silence.
    // Already AT the ceiling, so both the drag and the arrow that follows it clamp against `max`.
    // (`onWidth` is a spy, so the tab stays at the width it was given — which is what puts the
    // keyed nudge on the same bound the drag ended on, the exact case `lastClamp` used to swallow.)
    mountTab(560, 280, 560);
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 5000, buttons: 1 });
    fireEvent.mouseUp(window, { clientX: 5000 });
    info.mockClear();

    fireEvent.keyDown(dots(), { key: "ArrowRight" });
    expect(lines().some((l) => l.includes("clamped by max"))).toBe(true);
  });

  it("logs a HELD arrow at the clamp ONCE, not once per OS key repeat", () => {
    // Auto-repeat is ~30/s on macOS and a held arrow at a bound is the exact gesture this path
    // narrates. Every line costs a JSON render plus a synchronous IPC → disk write on the main
    // thread, so a per-repeat line makes the instrumentation into the jank it exists to diagnose.
    mountTab(560, 280, 560);
    for (let i = 0; i < 10; i++) fireEvent.keyDown(dots(), { key: "ArrowRight" });
    expect(lines().filter((l) => l.includes("clamped by max"))).toHaveLength(1);
  });

  it("logs AGAIN for a new press after the key is released", () => {
    // The run has to end with the KEY, not with a successful move. Latched on a move, `keyPinned`
    // stayed true forever: press at the clamp, release, press again minutes later — a genuinely new
    // gesture that goes nowhere — and nothing was logged. Auto-repeat emits no intervening `keyup`,
    // which is what lets one ref serve both.
    mountTab(560, 280, 560);
    fireEvent.keyDown(dots(), { key: "ArrowRight" });
    fireEvent.keyUp(dots(), { key: "ArrowRight" });
    fireEvent.keyDown(dots(), { key: "ArrowRight" });
    expect(lines().filter((l) => l.includes("clamped by max"))).toHaveLength(2);
  });

  it("does NOT re-arm on a key that commits nothing", () => {
    // Tab/Enter/characters must not clear the drag's edge state — that re-arms per-event logging on
    // a keystroke that moves no boundary at all.
    mountTab();
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 5000, buttons: 1 });
    info.mockClear();

    fireEvent.keyDown(dots(), { key: "Tab" });
    fireEvent.keyDown(dots(), { key: "Enter" });
    fireEvent.mouseMove(window, { clientX: 5100, buttons: 1 });
    expect(lines().filter((l) => l.includes("clamped by max"))).toHaveLength(0);
  });
});
