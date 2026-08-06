// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const publishHelperVitals = vi.fn();
vi.mock("./services/helper", () => ({
  publishHelperVitals: (...a: unknown[]) => publishHelperVitals(...a),
}));

let feed = { counts: { needs_you: 0, questions: 0, running: 0, done: 0 } };
vi.mock("./useConciergeFeed", () => ({ useConciergeFeed: () => feed }));

import { useHelperVitalsPublisher } from "./useHelperVitalsPublisher";

describe("useHelperVitalsPublisher", () => {
  beforeEach(() => {
    publishHelperVitals.mockClear();
    feed = { counts: { needs_you: 0, questions: 0, running: 0, done: 0 } };
  });

  it("publishes the current counts on mount", () => {
    feed = { counts: { needs_you: 3, questions: 0, running: 7, done: 0 } };
    renderHook(() => useHelperVitalsPublisher());
    expect(publishHelperVitals).toHaveBeenCalledWith(3, 7);
  });

  it("publishes zeros on mount so a stale island is corrected", () => {
    renderHook(() => useHelperVitalsPublisher());
    expect(publishHelperVitals).toHaveBeenCalledWith(0, 0);
  });

  it("republishes when the counts change", () => {
    const { rerender } = renderHook(() => useHelperVitalsPublisher());
    expect(publishHelperVitals).toHaveBeenCalledWith(0, 0);
    feed = { counts: { needs_you: 1, questions: 0, running: 2, done: 0 } };
    rerender();
    expect(publishHelperVitals).toHaveBeenLastCalledWith(1, 2);
  });

  it("does not republish when the counts are unchanged", () => {
    // The concierge feed memo recomputes on many inputs that don't move the counts; each publish
    // is a main-thread Tauri IPC, so a redundant one is real waste.
    const { rerender } = renderHook(() => useHelperVitalsPublisher());
    expect(publishHelperVitals).toHaveBeenCalledTimes(1);
    rerender();
    rerender();
    expect(publishHelperVitals).toHaveBeenCalledTimes(1);
  });

  it("republishes a drop back to zero", () => {
    feed = { counts: { needs_you: 4, questions: 0, running: 1, done: 0 } };
    const { rerender } = renderHook(() => useHelperVitalsPublisher());
    feed = { counts: { needs_you: 0, questions: 0, running: 0, done: 0 } };
    rerender();
    expect(publishHelperVitals).toHaveBeenLastCalledWith(0, 0);
  });
});
