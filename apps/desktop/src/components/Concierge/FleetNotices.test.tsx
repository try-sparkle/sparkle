// @vitest-environment jsdom
//
// THE PROPERTY: the wrapper is actually WIRED, and its clock advances.
//
// `FleetNoticeCard` is tested against conditions handed to it; `useFleetNotices` is tested against
// inputs handed to it. Neither can see the thing that was missing for four commits — that anything
// mounts them at all. These tests are about the mount: that a store condition reaches the screen,
// and that the duration numbers do not freeze on a quiet fleet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("../../useFleetNotices", () => ({ useFleetNotices: vi.fn(() => []) }));

import { FleetNotices, FLEET_NOTICE_TICK_MS } from "./FleetNotices";
import { useFleetNotices } from "../../useFleetNotices";
import { evaluateFleetConditions, type FleetSnapshot } from "@sparkle/core";

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const WEEKLY = "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)";

const walled = (id: string): FleetSnapshot => ({
  agentId: id,
  label: `Agent ${id}`,
  quota: { message: WEEKLY, resetAt: T0 + 4 * HOUR, resetParsed: true },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useFleetNotices).mockReturnValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FleetNotices", () => {
  it("renders nothing when there is nothing wrong", () => {
    const { container } = render(<FleetNotices />);
    expect(container.firstChild).toBeNull();
  });

  it("puts a real condition on screen", () => {
    vi.mocked(useFleetNotices).mockReturnValue(evaluateFleetConditions([walled("a")], T0));
    render(<FleetNotices />);
    expect(screen.getByTestId("fleet-notice")).toBeTruthy();
    expect(screen.getByText(new RegExp(WEEKLY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
  });

  // Two conditions are duration-based. A static clock would freeze "9h overdue" for as long as
  // nothing else in the stores changed — the card would quietly stop being true.
  it("advances its clock so duration-based conditions do not freeze", () => {
    vi.useFakeTimers();
    render(<FleetNotices />);
    const first = vi.mocked(useFleetNotices).mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(FLEET_NOTICE_TICK_MS);
    });

    const seen = vi.mocked(useFleetNotices).mock.calls.map((c) => c[0]);
    expect(vi.mocked(useFleetNotices).mock.calls.length).toBeGreaterThan(first);
    // ...and with a LATER clock, not the same one re-passed.
    expect(seen[seen.length - 1]!).toBeGreaterThan(seen[0]!);
  });

  // ASSERTS THE TIMER, NOT THE RE-RENDER (roborev 57483). React 18 makes a `setState` on an
  // unmounted component a silent no-op, so the call count stays flat whether or not the interval was
  // cleared — the obvious version of this test passes with the cleanup deleted, which is the vacuous
  // shape AGENTS.md calls the #1 fleet-wide finding.
  it("stops ticking when unmounted, so a closed column leaves no timer behind", () => {
    vi.useFakeTimers();
    const { unmount } = render(<FleetNotices />);
    // The interval really is armed while mounted — without this the assertion below could pass on a
    // component that never set one.
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
