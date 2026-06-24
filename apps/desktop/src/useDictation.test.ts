/**
 * useDictation hook tests — drive the Zustand store + event listeners directly
 * (no @testing-library/react / renderHook; mirrors the project's uiStore.test.ts pattern).
 *
 * Tauri APIs are mocked so the test runs in a plain Node/jsdom environment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Tauri mocks — must be set up before importing the modules under test
// ---------------------------------------------------------------------------

/** Simulated event bus keyed by event name */
const listeners: Record<string, (e: { payload: unknown }) => void> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners[name] = cb;
    return Promise.resolve(() => {
      delete listeners[name];
    });
  },
}));

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

// ---------------------------------------------------------------------------
// Modules under test (imported after mocks are registered)
// ---------------------------------------------------------------------------
import { useDictationStore } from "./stores/dictationStore";
import { createDictationController } from "./useDictation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Emit a fake Tauri event into the listener registry */
function emit(name: string, payload: unknown) {
  const cb = listeners[name];
  if (cb) cb({ payload });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dictationStore", () => {
  beforeEach(() => {
    // Reset to known initial state between tests
    useDictationStore.setState({
      status: "idle",
      level: 0,
      error: null,
      modelProgress: null,
    });
  });

  it("starts with idle status, zero level, no error, no modelProgress", () => {
    const s = useDictationStore.getState();
    expect(s.status).toBe("idle");
    expect(s.level).toBe(0);
    expect(s.error).toBeNull();
    expect(s.modelProgress).toBeNull();
  });

  it("setStatus updates status", () => {
    useDictationStore.getState().setStatus("listening");
    expect(useDictationStore.getState().status).toBe("listening");
  });

  it("setLevel updates level", () => {
    useDictationStore.getState().setLevel(0.75);
    expect(useDictationStore.getState().level).toBe(0.75);
  });

  it("setError sets error + transitions to error status; clearing from error → idle", () => {
    useDictationStore.getState().setError("oops");
    expect(useDictationStore.getState().error).toBe("oops");
    expect(useDictationStore.getState().status).toBe("error");
    useDictationStore.getState().setError(null);
    expect(useDictationStore.getState().error).toBeNull();
    expect(useDictationStore.getState().status).toBe("idle");
  });

  it("clearing error does NOT clobber an active listening session", () => {
    useDictationStore.setState({ status: "listening", error: null });
    useDictationStore.getState().setError(null);
    expect(useDictationStore.getState().error).toBeNull();
    expect(useDictationStore.getState().status).toBe("listening");
  });

  it("setModelProgress stores progress object", () => {
    useDictationStore.getState().setModelProgress({ done: 100, total: 482_000_000 });
    expect(useDictationStore.getState().modelProgress).toEqual({
      done: 100,
      total: 482_000_000,
    });
  });

  it("setModelProgress accepts null to clear", () => {
    useDictationStore.getState().setModelProgress({ done: 50, total: null });
    useDictationStore.getState().setModelProgress(null);
    expect(useDictationStore.getState().modelProgress).toBeNull();
  });
});

describe("createDictationController (hook logic without renderHook)", () => {
  let onSegment: ReturnType<typeof vi.fn>;
  let ctrl: Awaited<ReturnType<typeof createDictationController>>;

  beforeEach(async () => {
    invoke.mockClear();
    // Reset store
    useDictationStore.setState({
      status: "idle",
      level: 0,
      error: null,
      modelProgress: null,
    });
    // Reset listener registry
    for (const k of Object.keys(listeners)) delete listeners[k];

    onSegment = vi.fn();
    // A single controller per test; its toggle/cleanup are reused below so we
    // never leave shadowed/stale registrations in the mock listener registry.
    ctrl = await createDictationController({ onSegment });
  });

  afterEach(() => {
    ctrl?.cleanup();
  });

  it("registers listeners for all dictation events on construction", () => {
    expect(listeners["dictation://partial"]).toBeDefined();
    expect(listeners["dictation://level"]).toBeDefined();
    expect(listeners["dictation://error"]).toBeDefined();
    expect(listeners["dictation://model-progress"]).toBeDefined();
  });

  it("cleanup removes all registered listeners", () => {
    ctrl.cleanup();
    expect(listeners["dictation://partial"]).toBeUndefined();
    expect(listeners["dictation://level"]).toBeUndefined();
    expect(listeners["dictation://error"]).toBeUndefined();
    expect(listeners["dictation://model-progress"]).toBeUndefined();
  });

  it("toggle idle→listening: invokes start_dictation and sets status", async () => {
    await ctrl.toggle();
    expect(invoke).toHaveBeenCalledWith("start_dictation");
    expect(useDictationStore.getState().status).toBe("listening");
  });

  it("toggle listening→idle: invokes stop_dictation, resets level and status", async () => {
    useDictationStore.setState({ status: "listening", level: 0.5 });
    await ctrl.toggle();
    expect(invoke).toHaveBeenCalledWith("stop_dictation");
    expect(useDictationStore.getState().status).toBe("idle");
    expect(useDictationStore.getState().level).toBe(0);
  });

  it("dictation://partial forwards payload to onSegment", () => {
    emit("dictation://partial", "hello world");
    expect(onSegment).toHaveBeenCalledWith("hello world");
  });

  it("dictation://level updates store level", () => {
    emit("dictation://level", 0.8);
    expect(useDictationStore.getState().level).toBe(0.8);
  });

  it("dictation://error updates store error + status", () => {
    emit("dictation://error", "mic not found");
    expect(useDictationStore.getState().error).toBe("mic not found");
    expect(useDictationStore.getState().status).toBe("error");
  });

  it("dictation://model-progress updates modelProgress in store", () => {
    emit("dictation://model-progress", [123456, 482000000]);
    expect(useDictationStore.getState().modelProgress).toEqual({
      done: 123456,
      total: 482000000,
    });
  });

  it("dictation://model-progress with null total stores null total", () => {
    emit("dictation://model-progress", [99999, null]);
    expect(useDictationStore.getState().modelProgress).toEqual({
      done: 99999,
      total: null,
    });
  });

  it("dictation://level clears modelProgress (capture started)", () => {
    useDictationStore.setState({
      modelProgress: { done: 480_000_000, total: 482_000_000 },
    });
    emit("dictation://level", 0.3);
    expect(useDictationStore.getState().modelProgress).toBeNull();
  });

  it("dictation://partial clears modelProgress (capture started)", () => {
    useDictationStore.setState({
      modelProgress: { done: 100, total: 200 },
    });
    emit("dictation://partial", "first word");
    expect(useDictationStore.getState().modelProgress).toBeNull();
  });

  it("dictation://error clears modelProgress so mic button is not permanently disabled", () => {
    // Simulate: model-progress event sets modelProgress (download started)
    useDictationStore.setState({
      modelProgress: { done: 400_000_000, total: 482_000_000 },
      status: "listening",
    });
    // Then a dictation://error arrives (e.g. network failure during download)
    emit("dictation://error", "model download failed");
    // modelProgress must be cleared so micDisabled becomes false
    expect(useDictationStore.getState().modelProgress).toBeNull();
    // error and status must also be set correctly
    expect(useDictationStore.getState().error).toBe("model download failed");
    expect(useDictationStore.getState().status).toBe("error");
  });

  it("start_dictation rejection clears modelProgress so mic button is not permanently disabled", async () => {
    // Simulate: modelProgress set during download phase
    useDictationStore.setState({
      modelProgress: { done: 100_000_000, total: 482_000_000 },
    });
    // Backend rejects start_dictation (e.g. mic denied)
    invoke.mockRejectedValueOnce(new Error("mic permission denied"));
    await ctrl.toggle();
    // modelProgress must be cleared
    expect(useDictationStore.getState().modelProgress).toBeNull();
    // error must be set; status must not be "listening"
    expect(useDictationStore.getState().error).toBeTruthy();
    expect(useDictationStore.getState().status).not.toBe("listening");
  });

  it("stop during download clears modelProgress", async () => {
    useDictationStore.setState({
      status: "listening",
      modelProgress: { done: 200_000_000, total: 482_000_000 },
    });
    await ctrl.toggle();
    expect(useDictationStore.getState().modelProgress).toBeNull();
  });
});
