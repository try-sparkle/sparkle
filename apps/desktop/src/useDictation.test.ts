/**
 * useDictation hook tests — drive the Zustand store + event listeners directly
 * (no @testing-library/react / renderHook; mirrors the project's uiStore.test.ts pattern).
 *
 * Tauri APIs are mocked so the test runs in a plain Node/jsdom environment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { advance } from "./voice/wakeMachine";

// ---------------------------------------------------------------------------
// Tauri mocks — must be set up before importing the modules under test
// ---------------------------------------------------------------------------

/**
 * Simulated event bus keyed by event name. Tauri delivers an emitted event to
 * EVERY registered listener (a broadcast), so the mock stores an array per event
 * — modelling the real fan-out is what lets us reproduce the cross-agent leak.
 */
const listeners: Record<string, Array<(e: { payload: unknown }) => void>> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(cb);
    return Promise.resolve(() => {
      listeners[name] = (listeners[name] ?? []).filter((c) => c !== cb);
      if (listeners[name].length === 0) delete listeners[name];
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
import { createDictationController, cloudStreamCommandFor } from "./useDictation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Emit a fake Tauri event — broadcast to every registered listener, like Tauri. */
function emit(name: string, payload: unknown) {
  for (const cb of listeners[name] ?? []) cb({ payload });
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
    // No cloud arg: the cloud-dictation preference is read live at the wake→active transition
    // (start_cloud_stream), so toggling the menu takes effect without restarting dictation.
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

  it("dictation://interim updates the live preview in the store", () => {
    emit("dictation://interim", "hello wor");
    expect(useDictationStore.getState().interim).toBe("hello wor");
    emit("dictation://interim", "hello world");
    expect(useDictationStore.getState().interim).toBe("hello world"); // replaced in place
  });

  it("a committed partial clears the live interim preview", () => {
    useDictationStore.setState({ interim: "hello world" });
    emit("dictation://partial", "Hello world.");
    // The final segment supersedes the volatile preview so they don't double up.
    expect(useDictationStore.getState().interim).toBe("");
  });

  it("dictation://cloud-ended clears interim and invokes stop_cloud_stream (fallback handoff)", () => {
    useDictationStore.setState({ interim: "stale ghost" });
    invoke.mockClear();
    emit("dictation://cloud-ended", null);
    // Stale preview cleared, and the backend is told to resume on-device routing.
    expect(useDictationStore.getState().interim).toBe("");
    expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");
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

describe("dictation://focus (window-focus capture gate)", () => {
  let ctrl: Awaited<ReturnType<typeof createDictationController>>;

  beforeEach(async () => {
    invoke.mockClear();
    for (const k of Object.keys(listeners)) delete listeners[k];
    useDictationStore.setState({
      status: "listening",
      level: 0.6,
      error: null,
      interim: "live preview",
      phase: "active",
      enabled: true,
    });
    ctrl = await createDictationController({ onSegment: vi.fn() });
  });

  afterEach(() => ctrl?.cleanup());

  it("registers a dictation://focus listener", () => {
    expect(listeners["dictation://focus"]).toBeDefined();
  });

  it("blur (false): tears down cloud stream/level/interim and marks idle, but KEEPS the active phase and stays armed", () => {
    invoke.mockClear();
    emit("dictation://focus", false);
    const s = useDictationStore.getState();
    // Billable cloud stream torn down so tabbing away mid-dictation can't keep billing.
    expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");
    // Phase PERSISTS across a focus blur — the user must not have to re-say "Hey Sparkle" on return.
    expect(s.phase).toBe("active");
    expect(s.level).toBe(0);
    expect(s.interim).toBe("");
    expect(s.status).toBe("idle");
    // The mic stays ARMED — focus is a gate on top of the mute toggle, not the toggle itself.
    expect(s.enabled).toBe(true);
  });

  it("refocus (true) restores listening when still armed", () => {
    useDictationStore.setState({ status: "idle", phase: "passive", enabled: true });
    emit("dictation://focus", true);
    expect(useDictationStore.getState().status).toBe("listening");
  });

  it("refocus (true) while still ACTIVE resumes the cloud stream without a wake word", async () => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    const onResumeActive = vi.fn();
    const c = await createDictationController({ onSegment: vi.fn(), onResumeActive });
    useDictationStore.setState({ status: "idle", phase: "active", enabled: true });
    emit("dictation://focus", true);
    expect(useDictationStore.getState().status).toBe("listening");
    expect(onResumeActive).toHaveBeenCalledTimes(1);
    c.cleanup();
  });

  it("refocus (true) while PASSIVE does not resume a cloud stream", async () => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    const onResumeActive = vi.fn();
    const c = await createDictationController({ onSegment: vi.fn(), onResumeActive });
    useDictationStore.setState({ status: "idle", phase: "passive", enabled: true });
    emit("dictation://focus", true);
    expect(onResumeActive).not.toHaveBeenCalled();
    c.cleanup();
  });

  it("refocus (true) does NOT resume listening while muted", () => {
    useDictationStore.setState({ status: "idle", enabled: false });
    emit("dictation://focus", true);
    // enabled=false means the user muted; regaining window focus must not un-mute the UI.
    expect(useDictationStore.getState().status).toBe("idle");
  });

  it("focus events never clobber an error status", () => {
    useDictationStore.setState({ status: "error", error: "mic not found", enabled: true });
    emit("dictation://focus", false);
    expect(useDictationStore.getState().status).toBe("error");
    emit("dictation://focus", true);
    expect(useDictationStore.getState().status).toBe("error");
  });
});

describe("cloudStreamCommandFor (local gate, then stream)", () => {
  it("opens the cloud stream when transitioning to ACTIVE (wake word)", () => {
    expect(cloudStreamCommandFor({ phase: "active", insert: null, transitioned: true })).toBe(
      "start_cloud_stream",
    );
  });

  it("closes the cloud stream when transitioning to PASSIVE (stop word)", () => {
    expect(cloudStreamCommandFor({ phase: "passive", insert: null, transitioned: true })).toBe(
      "stop_cloud_stream",
    );
  });

  it("does nothing for a non-transition (text inserted mid-dictation keeps the stream open)", () => {
    expect(cloudStreamCommandFor({ phase: "active", insert: "more words", transitioned: false })).toBeNull();
    expect(cloudStreamCommandFor({ phase: "passive", insert: null, transitioned: false })).toBeNull();
  });
});

describe("ambient segment routing via the phase machine", () => {
  beforeEach(() => {
    useDictationStore.setState({ phase: "passive", insertTarget: null, enabled: true });
  });

  it("passive: wake segment flips phase to active and inserts the remainder", () => {
    const inserted: string[] = [];
    useDictationStore.getState().registerInsert((t) => inserted.push(t));

    // Simulate what the ambient onSegment does (the hook wires this to dictation://partial):
    const seg = "hey sparkle open the settings";
    const r = advance(useDictationStore.getState().phase, seg);
    useDictationStore.getState().setPhase(r.phase);
    if (r.insert) useDictationStore.getState().insert(r.insert);

    expect(useDictationStore.getState().phase).toBe("active");
    expect(inserted).toEqual(["open the settings"]);
  });

  it("passive: non-wake speech does not insert", () => {
    const inserted: string[] = [];
    useDictationStore.getState().registerInsert((t) => inserted.push(t));
    const r = advance("passive", "just talking to a colleague");
    if (r.insert) useDictationStore.getState().insert(r.insert);
    expect(inserted).toEqual([]);
    expect(r.phase).toBe("passive");
  });
});

describe("multiple mounted composers (regression: dictation must not leak across agents)", () => {
  // Repro for the bug where dictating into one agent's composer also filled a
  // different agent's input box. Agent panes stay mounted-but-hidden and the
  // dictation pipeline broadcasts every segment. Leak prevention is now a single
  // shared insertTarget in the store: only the active/visible pane calls
  // registerInsert(), and its cleanup guard (insertTarget === append) avoids a
  // stale pane clobbering a newer one. These tests drive that real mechanism.
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    useDictationStore.setState({
      status: "idle",
      level: 0,
      error: null,
      modelProgress: null,
      phase: "passive",
      enabled: true,
      insertTarget: null,
    });
  });

  it("only the active pane's registered target receives insert(); switching panes re-targets", () => {
    const a: string[] = [];
    const b: string[] = [];
    const appendA = (t: string) => a.push(t);
    const appendB = (t: string) => b.push(t);
    const store = () => useDictationStore.getState();

    // Pane A is the visible pane → it registers as the single insert target.
    store().registerInsert(appendA);
    store().insert("hello");
    expect(a).toEqual(["hello"]);
    expect(b).toEqual([]); // must NOT leak into the hidden pane

    // User switches to pane B; B registers and becomes the sole target.
    store().registerInsert(appendB);
    store().insert("world");
    expect(b).toEqual(["world"]);
    expect(a).toEqual(["hello"]); // A no longer receives anything

    // Pane A's late cleanup must NOT clobber B's registration (the guard).
    if (store().insertTarget === appendA) store().registerInsert(null);
    expect(store().insertTarget).toBe(appendB);
    store().insert("still B");
    expect(b).toEqual(["world", "still B"]);
  });

  it("broadcast reaches every mounted listener (why gating is required)", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const ctrlA = await createDictationController({ onSegment: a });
    const ctrlB = await createDictationController({ onSegment: b });

    emit("dictation://partial", "seg");
    // Both fire — Tauri does not route by pane; the active-gate above is what
    // confines the text to one composer.
    expect(a).toHaveBeenCalledWith("seg");
    expect(b).toHaveBeenCalledWith("seg");

    ctrlA.cleanup();
    ctrlB.cleanup();
  });
});
