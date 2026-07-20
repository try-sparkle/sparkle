/**
 * crossWindowSync tests — node env. We mock @tauri-apps/api/event (mirrors
 * useDictation.test.ts) and shim a minimal `window` with __TAURI_INTERNALS__ so the
 * in-Tauri broadcast path is exercised without a real webview.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const emit = vi.fn();
// Each store wires its own listener; capture them by event name so a test can fire the right one.
const captured = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...a: unknown[]) => emit(...a),
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    captured.set(name, cb);
    return Promise.resolve(() => {});
  },
}));

import { subscribeToCrossWindowSync } from "./crossWindowSync";
import { useProjectStore } from "../stores/projectStore";
import { useDictationStore } from "../stores/dictationStore";

let unsub: () => void = () => {};

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useDictationStore.setState({ enabled: true });
  localStorage.clear();
  emit.mockClear();
  captured.clear();
  // Minimal window shim: addEventListener/removeEventListener + the Tauri marker.
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    __TAURI_INTERNALS__: {},
  };
});

afterEach(() => {
  unsub();
  // The coalescing tests opt into fake timers; always hand back real ones so ordering between
  // tests can't depend on which ran first.
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("subscribeToCrossWindowSync", () => {
  it("broadcasts on a structural change (addProject)", () => {
    unsub = subscribeToCrossWindowSync();
    useProjectStore.getState().addProject("P", "/tmp/p");
    expect(emit).toHaveBeenCalledWith("sparkle://projects-changed");
  });

  it("does NOT broadcast on a non-structural change (appendPrompt)", () => {
    const id = useProjectStore.getState().addProject("P", "/tmp/p");
    const agentId = useProjectStore.getState().addAgent(id);
    unsub = subscribeToCrossWindowSync();
    emit.mockClear();
    useProjectStore.getState().appendPrompt(id, agentId, "typing a long prompt...");
    expect(emit).not.toHaveBeenCalled();
  });

  it("rehydrates when a remote change event arrives", () => {
    const rehydrate = vi
      .spyOn(useProjectStore.persist, "rehydrate")
      .mockResolvedValue(undefined as unknown as void);
    unsub = subscribeToCrossWindowSync();
    const fire = captured.get("sparkle://projects-changed");
    expect(fire).toBeDefined();
    fire?.({ payload: undefined });
    expect(rehydrate).toHaveBeenCalled();
    rehydrate.mockRestore();
  });

  it("coalesces a burst of remote events into one leading + one trailing rehydrate", async () => {
    // A structural burst emits one event per mutation. Rehydrate always reads the CURRENT blob, so
    // the intermediate runs are pure waste — each re-parses the whole blob and re-renders every
    // subscriber. The burst must collapse to the immediate (leading) run plus one trailing run that
    // picks up everything that landed after it.
    vi.useFakeTimers();
    const rehydrate = vi
      .spyOn(useProjectStore.persist, "rehydrate")
      .mockResolvedValue(undefined as unknown as void);
    unsub = subscribeToCrossWindowSync();
    const fire = captured.get("sparkle://projects-changed");

    for (let i = 0; i < 50; i++) fire?.({ payload: undefined });
    // Leading edge only: the other 49 folded into the pending trailing run.
    expect(rehydrate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(rehydrate).toHaveBeenCalledTimes(2);

    // Burst over — no further runs from the events already collapsed.
    await vi.advanceTimersByTimeAsync(500);
    expect(rehydrate).toHaveBeenCalledTimes(2);
    rehydrate.mockRestore();
  });

  it("rehydrates a later isolated event rather than dropping it", async () => {
    // Coalescing must never lose an update: once the cooldown lapses, a fresh event rehydrates
    // immediately again.
    vi.useFakeTimers();
    const rehydrate = vi
      .spyOn(useProjectStore.persist, "rehydrate")
      .mockResolvedValue(undefined as unknown as void);
    unsub = subscribeToCrossWindowSync();
    const fire = captured.get("sparkle://projects-changed");

    fire?.({ payload: undefined });
    expect(rehydrate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);

    fire?.({ payload: undefined });
    expect(rehydrate).toHaveBeenCalledTimes(2);
    rehydrate.mockRestore();
  });

  it("does not fire a trailing rehydrate after teardown", async () => {
    vi.useFakeTimers();
    const rehydrate = vi
      .spyOn(useProjectStore.persist, "rehydrate")
      .mockResolvedValue(undefined as unknown as void);
    unsub = subscribeToCrossWindowSync();
    const fire = captured.get("sparkle://projects-changed");

    fire?.({ payload: undefined });
    fire?.({ payload: undefined }); // queues a trailing run
    await vi.advanceTimersByTimeAsync(0);
    unsub();
    unsub = () => {};

    await vi.advanceTimersByTimeAsync(500);
    expect(rehydrate).toHaveBeenCalledTimes(1);
    rehydrate.mockRestore();
  });

  it("does not arm a cooldown when teardown lands mid-rehydrate", async () => {
    // Covers the other teardown race: unsub() while a rehydrate is still IN FLIGHT. Its .finally
    // resolves after teardown has already drained `unsubs`, so the isTorndown() check is the only
    // thing stopping it from arming a timer against a closed webview. A manually-resolved deferred
    // holds the rehydrate open across the unsub() call — mockResolvedValue would settle too early
    // and this would silently only re-test the clearTimeout path.
    //
    // Assert on the TIMER, not on the rehydrate count: teardown also clears `pending`, so the
    // trailing run can't fire either way and a call-count assertion here passes with or without the
    // guard (i.e. it would be vacuous). The stray armed timer is the guard's only observable effect.
    vi.useFakeTimers();
    let resolveRehydrate: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      resolveRehydrate = r;
    });
    const rehydrate = vi
      .spyOn(useProjectStore.persist, "rehydrate")
      .mockReturnValue(inFlight as unknown as void);
    unsub = subscribeToCrossWindowSync();
    const fire = captured.get("sparkle://projects-changed");

    fire?.({ payload: undefined }); // leading run — now in flight, unresolved
    fire?.({ payload: undefined }); // lands while running → marks pending
    expect(rehydrate).toHaveBeenCalledTimes(1);

    unsub(); // teardown BEFORE the in-flight rehydrate settles
    unsub = () => {};
    const timersAtTeardown = vi.getTimerCount();

    // Let the in-flight rehydrate's .finally run. Without the isTorndown() guard it arms a cooldown
    // timer here, against a store whose listeners are already gone.
    // advanceTimersByTimeAsync(0) drains the microtask queue without reaching the 50ms cooldown, so
    // a stray armed timer is still counted. Don't count ticks by hand here (two `await
    // Promise.resolve()` lands exactly on the boundary with zero slack) — one more `await` inside
    // perfSpanAsync would leave the .finally un-run and this assertion would pass vacuously,
    // silently dropping the coverage it exists to provide.
    resolveRehydrate();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(timersAtTeardown);

    await vi.advanceTimersByTimeAsync(500);
    expect(rehydrate).toHaveBeenCalledTimes(1);
    rehydrate.mockRestore();
  });

  it("does NOT re-broadcast after a remote event (no rehydrate→emit loop)", async () => {
    // Real (unmocked) persist.rehydrate mutates the store via set(), which fires the subscriber
    // *during* applyingRemote. The guard must swallow that write so we don't echo a new event.
    useProjectStore.getState().addProject("P", "/tmp/p");
    unsub = subscribeToCrossWindowSync();
    emit.mockClear();
    captured.get("sparkle://projects-changed")?.({ payload: undefined });
    // Let rehydrate's promise + .finally settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).not.toHaveBeenCalled();
  });

  it("broadcasts the dictation mute toggle across windows", () => {
    unsub = subscribeToCrossWindowSync();
    emit.mockClear();
    useDictationStore.getState().setEnabled(false);
    expect(emit).toHaveBeenCalledWith("sparkle://dictation-changed");
  });

  it("broadcasts a phase change (paused↔active) across windows", () => {
    // The user's active/paused selection must fan out to other windows just like the mute toggle,
    // so focusing another project shows the shared status. Seed passive BEFORE wiring so `last` is
    // seeded from passive and the change to active is genuinely a change.
    useDictationStore.setState({ phase: "passive" });
    unsub = subscribeToCrossWindowSync();
    emit.mockClear();
    useDictationStore.getState().setPhase("active");
    expect(emit).toHaveBeenCalledWith("sparkle://dictation-changed");
  });

  it("does NOT broadcast on a non-persisted dictation change (mic level)", () => {
    unsub = subscribeToCrossWindowSync();
    emit.mockClear();
    useDictationStore.getState().setLevel(0.42);
    expect(emit).not.toHaveBeenCalled();
  });

  it("does NOT broadcast a change that lands before hydration finishes; resumes after", () => {
    // Force the not-yet-hydrated window. With synchronous mock storage the real store hydrates
    // during creation, so we stub hasHydrated()/onFinishHydration() to drive the gate directly.
    let finishHydration: (() => void) | undefined;
    const hasHydrated = vi.spyOn(useDictationStore.persist, "hasHydrated").mockReturnValue(false);
    const onFinish = vi
      .spyOn(useDictationStore.persist, "onFinishHydration")
      .mockImplementation((fn) => {
        finishHydration = fn as () => void;
        return () => {};
      });

    unsub = subscribeToCrossWindowSync();
    emit.mockClear();

    // A change that lands while hydration is still in flight must NOT fan out — it's the persisted
    // value being restored, not a user toggle.
    useDictationStore.getState().setEnabled(false);
    expect(emit).not.toHaveBeenCalledWith("sparkle://dictation-changed");

    // Once hydration settles, `last` is reseeded from the hydrated value and real toggles resume.
    finishHydration?.();
    useDictationStore.getState().setEnabled(true);
    expect(emit).toHaveBeenCalledWith("sparkle://dictation-changed");

    hasHydrated.mockRestore();
    onFinish.mockRestore();
  });
});
