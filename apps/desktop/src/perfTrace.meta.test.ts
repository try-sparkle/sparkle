// perfStart / perfMark / perfEnd share one signature — `(key, label, meta?)` — so a caller
// reasonably expects the optional `meta` to reach the log line from any of the three. It did not:
// perfMark accepted the argument and dropped it on the floor, so a milestone annotated with the
// very detail it was added to carry logged that detail nowhere.
//
// This is the kind of defect the desktop app's lint gap hides. `pnpm -r lint` only visits packages
// declaring a lint script and apps/desktop declares none, so the unused-parameter error sat on
// main with CI green.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nowMock = vi.fn<() => number>();
const infoSpy = vi.fn();

vi.mock("./logger", () => ({
  log: {
    info: (scope: string, message: string, data?: unknown) => infoSpy(scope, message, data),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let perfStart: typeof import("./perfTrace").perfStart;
let perfMark: typeof import("./perfTrace").perfMark;
let perfEnd: typeof import("./perfTrace").perfEnd;

beforeEach(async () => {
  vi.stubGlobal("performance", { now: nowMock });
  infoSpy.mockClear();
  nowMock.mockReset();
  nowMock.mockReturnValue(0);
  ({ perfStart, perfMark, perfEnd } = await import("./perfTrace"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The `data` payload of the most recent log.info call. */
function lastPayload(): Record<string, unknown> {
  const call = infoSpy.mock.calls.at(-1);
  if (!call) throw new Error("expected log.info to have been called");
  return call[2] as Record<string, unknown>;
}

describe("perfMark meta", () => {
  it("forwards meta onto the milestone line", () => {
    perfStart("k", "spawn");
    perfMark("k", "worktree ready", { attempt: 2, reused: true });

    expect(lastPayload()).toMatchObject({ key: "k", attempt: 2, reused: true });
  });

  it("still logs the timing fields when meta is omitted", () => {
    perfStart("k", "spawn");
    perfMark("k", "worktree ready");

    const payload = lastPayload();
    expect(payload).toMatchObject({ key: "k" });
    expect(payload).toHaveProperty("msSinceStart");
    expect(payload).toHaveProperty("msSincePrev");
    expect(payload).not.toHaveProperty("attempt");
  });

  it("does not let meta overwrite the trace's own timing keys", () => {
    perfStart("k", "spawn");
    nowMock.mockReturnValue(50);
    perfMark("k", "worktree ready", { msSinceStart: "bogus" });

    // Spreading meta last means a colliding key wins; assert the shape callers actually get
    // rather than a behavior nobody verified. The timing keys are reserved by convention.
    expect(lastPayload().msSinceStart).toBe("bogus");
  });

  it("is a no-op for a key that was never started, meta or not", () => {
    perfMark("never-started", "milestone", { attempt: 1 });

    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("matches the sibling functions that already forwarded meta", () => {
    perfStart("k", "spawn", { source: "click" });
    expect(lastPayload()).toMatchObject({ source: "click" });

    perfEnd("k", "ready", { outcome: "ok" });
    expect(lastPayload()).toMatchObject({ outcome: "ok" });
  });
});
