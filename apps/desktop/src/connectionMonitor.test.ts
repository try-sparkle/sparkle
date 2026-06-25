import { describe, it, expect, vi } from "vitest";
import { createProbeRunner } from "./connectionMonitor";

// The probe runner is the concurrency-sensitive core of the heartbeat: it must fire onRecover
// exactly once per offline→online edge even when triggers overlap. Deps are injected so we can
// exercise that without React or Tauri.
describe("createProbeRunner — concurrency-safe edge detection", () => {
  function harness(initialOnline: boolean, probe: () => Promise<boolean>) {
    let online = initialOnline;
    const onRecover = vi.fn();
    const run = createProbeRunner({
      probe,
      applyProbe: (ok) => {
        online = ok;
      },
      isOnline: () => online,
      onRecover,
    });
    return { run, onRecover };
  }

  it("fires onRecover once on the offline→online edge", async () => {
    const { run, onRecover } = harness(false, async () => true);
    await run();
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it("does not fire while staying online (no edge, e.g. on boot)", async () => {
    const { run, onRecover } = harness(true, async () => true);
    await run();
    expect(onRecover).not.toHaveBeenCalled();
  });

  it("drops an overlapping probe so recovery is not double-fired", async () => {
    let release!: (v: boolean) => void;
    const probe = vi.fn().mockImplementation(
      () => new Promise<boolean>((r) => (release = r)),
    );
    const { run, onRecover } = harness(false, probe);
    const first = run(); // enters, awaits the (pending) probe
    const second = run(); // in-flight guard → immediate no-op, never calls probe
    expect(release).toBeDefined(); // probe ran synchronously up to its await; release is wired
    release(true); // first probe resolves: offline→online
    await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it("treats a thrown probe as inconclusive: no throw, no recover, prev preserved", async () => {
    let online = false;
    let throwIt = true;
    const onRecover = vi.fn();
    const run = createProbeRunner({
      probe: async () => {
        if (throwIt) throw new Error("probe boom");
        return true;
      },
      applyProbe: (ok) => {
        online = ok;
      },
      isOnline: () => online,
      onRecover,
    });
    // A thrown probe must not reject out to the `void runProbe()` callers, and must not move the
    // edge baseline — so the genuine recovery on the next (successful) probe still fires once.
    await expect(run()).resolves.toBeUndefined();
    expect(onRecover).not.toHaveBeenCalled();
    throwIt = false;
    await run();
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it("re-fires on a later edge after dropping offline again", async () => {
    let next = true;
    const { run, onRecover } = harness(false, async () => next);
    await run(); // false→true: fire (1)
    next = false;
    await run(); // true→false: no fire
    next = true;
    await run(); // false→true: fire (2)
    expect(onRecover).toHaveBeenCalledTimes(2);
  });
});
