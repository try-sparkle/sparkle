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
import { useAuthStore } from "./stores/authStore";
import { useUiStore } from "./stores/uiStore";
import { createDictationController, cloudStreamCommandFor } from "./useDictation";

/** A minimal signed-in `me` for the credits-pill tests. */
const meWith = (balanceCents: number) => ({
  clerkUserId: "u1",
  entitled: true,
  balanceCents,
  tokenVersion: 1,
});

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

/**
 * Resets BOTH pieces of shared module state, file-level so it runs before every describe block's own
 * `beforeEach`. No describe-level hook resets either one, and this project's vite config sets no
 * `mockReset`/`restoreMocks`/`clearMocks`. Doing it once here is what makes that safe by
 * construction instead of by each block remembering.
 *
 * `invoke`: `mockClear` wipes call history but LEAVES any `mockImplementation` in place, so an
 * implementation installed by the last test of one block (a never-resolving `start_dictation`, or an
 * unconsumed `mockRejectedValueOnce`) would survive across the describe boundary — the next
 * `await ctrl.toggle()` then hangs to the vitest timeout with nothing pointing at the cause.
 *
 * `listeners`: the mock event bus is module-level and `emit()` broadcasts to every registration, so a
 * controller left registered by a previous block keeps receiving events and fires phantom
 * `onSegment` calls in the next one.
 *
 * Kept in this file rather than `mockReset: true` in vite.config.ts: the global flag would reset
 * mocks for all 355 test files AND wipe the module-level `invoke.mockResolvedValue`, leaving `invoke`
 * returning undefined instead of a promise — far more blast radius than the problem warrants.
 */
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  for (const k of Object.keys(listeners)) delete listeners[k];
});

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
    // `invoke` is reset by the file-level beforeEach above, which covers every describe block.
    // Reset store
    useDictationStore.setState({
      status: "idle",
      level: 0,
      error: null,
      modelProgress: null,
    });

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
    expect(listeners["dictation://audio-recovered"]).toBeDefined();
    expect(listeners["dictation://model-progress"]).toBeDefined();
  });

  it("cleanup removes all registered listeners", () => {
    ctrl.cleanup();
    expect(listeners["dictation://partial"]).toBeUndefined();
    expect(listeners["dictation://level"]).toBeUndefined();
    expect(listeners["dictation://error"]).toBeUndefined();
    expect(listeners["dictation://audio-recovered"]).toBeUndefined();
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

  it("dictation://cloud-ended with exhausted=true refreshes the balance (relay ran out of credits)", () => {
    const refresh = vi.spyOn(useAuthStore.getState(), "refresh").mockResolvedValue();
    emit("dictation://cloud-ended", true);
    // Out-of-credits teardown → refresh so the credits pill reflects the now-depleted balance.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");
    refresh.mockRestore();
  });

  it("dictation://cloud-ended with exhausted=false (clean close) does NOT refresh the balance", () => {
    const refresh = vi.spyOn(useAuthStore.getState(), "refresh").mockResolvedValue();
    emit("dictation://cloud-ended", false);
    expect(refresh).not.toHaveBeenCalled();
    refresh.mockRestore();
  });

  it("dictation://cloud-balance ticks the credits pill down from the relay's server balance", () => {
    useAuthStore.setState({ me: meWith(20000) });
    emit("dictation://cloud-balance", { balanceCents: 19994, debitedCents: 6 });
    // Server-authoritative post-debit balance wins.
    expect(useAuthStore.getState().me?.balanceCents).toBe(19994);
  });

  it("dictation://cloud-balance optimistically decrements when the relay omits the balance", () => {
    useAuthStore.setState({ me: meWith(19994) });
    emit("dictation://cloud-balance", { balanceCents: null, debitedCents: 5 });
    expect(useAuthStore.getState().me?.balanceCents).toBe(19989);
  });

  it("dictation://cloud-balance re-arms a dismissed $0 banner when the balance goes positive", () => {
    // This frame carries the SERVER-authoritative balance, so a top-up can land here rather than
    // through refresh(). Writing `me` with a bare setState skipped the re-arm rule and latched the
    // dismissal for the rest of the session, silently swallowing the next $0 episode. (roborev 48271)
    useAuthStore.setState({ me: meWith(0) });
    useUiStore.setState({ zeroCreditBannerDismissed: true, zeroCreditBannerDismissedFor: "u1" });
    emit("dictation://cloud-balance", { balanceCents: 2500, debitedCents: 0 });
    expect(useAuthStore.getState().me?.balanceCents).toBe(2500);
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(false);
  });

  it("dictation://cloud-balance is a no-op when signed out (no me to update)", () => {
    useAuthStore.setState({ me: null });
    emit("dictation://cloud-balance", { balanceCents: 100, debitedCents: 6 });
    expect(useAuthStore.getState().me).toBeNull();
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
    // 482 MB is the COMPRESSED tarball's content-length — what the byte stream (and therefore this
    // progress pair) actually counts. The unpacked model is ~631 MB on disk; don't "correct" this
    // to that number, it would no longer match what the backend reports.
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

describe("dictation://audio-recovered (the frame-liveness watchdog's all-clear)", () => {
  // The 2026-07-29 incident: a screen recorder's CoreAudio HAL plug-in left capture "live" while
  // ZERO frames arrived for nine minutes, and the UI painted a normal idle waveform throughout. The
  // backend watchdog now reports that as a dictation://error and takes it back with this event when
  // frames resume. Taking it back must be SURGICAL — see the discriminating test below.
  const NO_AUDIO_ERROR =
    `No audio from "MacBook Pro Microphone". Another app (a screen recorder or virtual audio ` +
    `device) may be holding the microphone. Pick a different input in the mic menu, or turn the ` +
    `mic off and on.`;
  /** A failure that is STILL TRUE when frames resume — audio flowing again says nothing about a
   *  half-downloaded voice model, so this notice must survive the all-clear. */
  const UNRELATED_ERROR = "model download completed but expected files are missing";

  let ctrl: Awaited<ReturnType<typeof createDictationController>>;

  beforeEach(async () => {
    // `enabled: true` is the real shape of this fault: the watchdog fires MID-SESSION, so the mic is
    // armed and capturing throughout — it is only the frames that stopped.
    useDictationStore.setState({
      status: "idle",
      level: 0,
      error: null,
      modelProgress: null,
      enabled: true,
      deadMicSilent: false,
    });
    ctrl = await createDictationController({ onSegment: vi.fn() });
  });

  afterEach(() => ctrl?.cleanup());

  it("still restores listening when the user DISMISSED the notice before fixing the mic", () => {
    // The ordinary sequence, and the one an earlier version got wrong: read the warning, close it,
    // THEN quit the screen recorder. Gating recovery on the visible `error` meant this arrived with
    // error === null and early-returned, leaving a live capturing mic drawn as PAUSED for as long
    // as the user stayed in the window. The fault is not dismissible; only the notice is — so the
    // fault is tracked separately and this is what proves the two are not the same thing.
    emit("dictation://error", NO_AUDIO_ERROR);
    expect(useDictationStore.getState().deadMicSilent).toBe(true);

    useDictationStore.getState().setError(null); // what the Dismiss button does
    expect(useDictationStore.getState().status).toBe("idle");

    emit("dictation://audio-recovered", null);
    expect(useDictationStore.getState().status).toBe("listening");
    expect(useDictationStore.getState().deadMicSilent).toBe(false);
  });

  it("an unrelated error arriving after the fault does NOT get wiped by the all-clear", () => {
    // The all-clear says frames are flowing. That is no evidence at all about a failed model
    // download or a denied permission, so an unrelated notice must survive it — otherwise we trade
    // the bug where the UI hid a dead mic for the bug where it hides a denied one.
    emit("dictation://error", NO_AUDIO_ERROR);
    emit("dictation://error", UNRELATED_ERROR);

    emit("dictation://audio-recovered", null);
    expect(useDictationStore.getState().error).toBe(UNRELATED_ERROR);
    expect(useDictationStore.getState().status).toBe("error");
  });

  it("an unrelated error does not ERASE the dead-mic fault (roborev 55351)", () => {
    // The fault used to be ASSIGNED on every error, so an unrelated failure landing between the
    // fault and its all-clear erased it. The recovery event then early-returned, and once the user
    // dismissed that unrelated notice — status "error" → "idle" with capture still live —
    // deriveMicState drew a PAUSED mic over a working one. The same incident, one route across.
    emit("dictation://error", NO_AUDIO_ERROR);
    emit("dictation://error", UNRELATED_ERROR);
    expect(useDictationStore.getState().deadMicSilent).toBe(true);

    useDictationStore.getState().setError(null); // the user dismisses the unrelated notice
    emit("dictation://audio-recovered", null);
    // The fault survived long enough to be retracted by real evidence, and the mic is drawn live.
    expect(useDictationStore.getState().deadMicSilent).toBe(false);
    expect(useDictationStore.getState().status).toBe("listening");
  });

  it("clears the dead-mic notice AND puts the still-armed mic back to listening", () => {
    emit("dictation://error", NO_AUDIO_ERROR);
    expect(useDictationStore.getState().error).toBe(NO_AUDIO_ERROR);
    expect(useDictationStore.getState().status).toBe("error");

    emit("dictation://audio-recovered", null);
    // The fault is over, so the notice must go — a stale "Sparkle isn't hearing your microphone"
    // over a working mic is the same lie in the other direction.
    expect(useDictationStore.getState().error).toBeNull();
    // And status must not be left at "idle". setError(null) lands there on its way out of "error",
    // but capture never stopped: deriveMicState(enabled=true, "idle", …) draws a PAUSED mic, so a
    // demonstrably recovered mic would keep rendering as not-listening until the user cycled it by
    // hand. Asserting only `error === null` would have shipped exactly that.
    expect(useDictationStore.getState().status).toBe("listening");
  });

  it("does NOT claim listening while Sparkle is UNFOCUSED (nothing is being captured there)", async () => {
    // The sequence this notice's own remedy invites: it tells the user to go to System Settings →
    // Sound, which blurs Sparkle. An unfocused app is not capturing — dictation://focus(false)
    // parks status at "idle" on purpose — so frames resuming while we're away must not paint a
    // listening mic over a session that isn't running. The focus handler restores it on return.
    ctrl.cleanup(); // drop the block's focused controller so only this one sees the broadcast
    const bg = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => false,
    });
    emit("dictation://error", NO_AUDIO_ERROR);
    emit("dictation://audio-recovered", null);
    // The notice is stale either way, so it still goes.
    expect(useDictationStore.getState().error).toBeNull();
    expect(useDictationStore.getState().status).toBe("idle");
    bg.cleanup();
  });

  it("does NOT un-mute a mic the user muted while the fault was showing", () => {
    emit("dictation://error", NO_AUDIO_ERROR);
    useDictationStore.setState({ enabled: false }); // user gave up and muted
    emit("dictation://audio-recovered", null);
    // The notice is stale either way, so it goes; but "listening" would contradict the mute and
    // re-arm the UI behind the user's back.
    expect(useDictationStore.getState().error).toBeNull();
    expect(useDictationStore.getState().status).toBe("idle");
  });

  it("clears ONLY the dead-mic notice — an unrelated failure showing at the time survives", () => {
    // THE test. A blanket setError(null) here would pass the case above while silently erasing a
    // model-download failure or a permission denial that is still true and still needs the user.
    emit("dictation://error", UNRELATED_ERROR);
    emit("dictation://audio-recovered", null);
    expect(useDictationStore.getState().error).toBe(UNRELATED_ERROR);
    expect(useDictationStore.getState().status).toBe("error");

    // Same controller, same event, immediately after: proves the listener really is live, so the
    // assertion above is a guard doing its job rather than "nothing happened because nothing is
    // wired up" — which is how this test would otherwise pass against a version with no listener.
    emit("dictation://error", NO_AUDIO_ERROR);
    emit("dictation://audio-recovered", null);
    expect(useDictationStore.getState().error).toBeNull();
  });

  it("is a no-op when no error is showing (recovery can arrive without a preceding fault)", () => {
    useDictationStore.setState({ status: "listening", error: null });
    emit("dictation://audio-recovered", null);
    // Must not knock a healthy live session out of "listening" on its way through setError(null).
    expect(useDictationStore.getState().status).toBe("listening");
    expect(useDictationStore.getState().error).toBeNull();
  });
});

describe("multi-window routing (isWindowActive gate)", () => {
  // The backend broadcasts dictation://* to EVERY window; only the focused one should consume the
  // text. We model two windows by registering two controllers with opposite focus predicates and
  // asserting the broadcast (emit fans out to both listeners) lands in only the active one.
  beforeEach(() => {
    useDictationStore.setState({ interim: "", modelProgress: null });
  });

  it("an inactive (background) window ignores a broadcast committed partial", async () => {
    const onSegment = vi.fn();
    const ctrl = await createDictationController({ onSegment, isWindowActive: () => false });
    emit("dictation://partial", "hello from the other window");
    expect(onSegment).not.toHaveBeenCalled();
    ctrl.cleanup();
  });

  it("the active window still receives the committed partial", async () => {
    const onSegment = vi.fn();
    const ctrl = await createDictationController({ onSegment, isWindowActive: () => true });
    emit("dictation://partial", "hello world");
    expect(onSegment).toHaveBeenCalledWith("hello world");
    ctrl.cleanup();
  });

  it("a single broadcast lands in ONLY the focused window when two are open", async () => {
    const activeSeg = vi.fn();
    const bgSeg = vi.fn();
    const active = await createDictationController({ onSegment: activeSeg, isWindowActive: () => true });
    const background = await createDictationController({ onSegment: bgSeg, isWindowActive: () => false });
    // One backend emission fans out to both windows' listeners (real Tauri behavior).
    emit("dictation://partial", "type me once");
    expect(activeSeg).toHaveBeenCalledTimes(1);
    expect(activeSeg).toHaveBeenCalledWith("type me once");
    expect(bgSeg).not.toHaveBeenCalled(); // the fix: no duplicate into the background window
    active.cleanup();
    background.cleanup();
  });

  it("an inactive window does not paint the live interim ghost (and clears any stale one)", async () => {
    const ctrl = await createDictationController({ onSegment: vi.fn(), isWindowActive: () => false });
    useDictationStore.setState({ interim: "stale ghost" });
    emit("dictation://interim", "live words");
    // Background window neither shows the new preview nor keeps a stale one.
    expect(useDictationStore.getState().interim).toBe("");
    ctrl.cleanup();
  });

  it("the active window paints the live interim ghost as usual", async () => {
    const ctrl = await createDictationController({ onSegment: vi.fn(), isWindowActive: () => true });
    emit("dictation://interim", "live words");
    expect(useDictationStore.getState().interim).toBe("live words");
    ctrl.cleanup();
  });
});

describe("dictation://focus (window-focus capture gate)", () => {
  let ctrl: Awaited<ReturnType<typeof createDictationController>>;

  beforeEach(async () => {
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
    // Drop the block's own controller (beforeEach registered one) so only the controller this case
    // creates receives the broadcast. Targeted rather than purging the whole registry, which would
    // orphan `ctrl` and quietly turn its afterEach cleanup into a no-op. Double-cleanup is safe.
    ctrl.cleanup();
    const onResumeActive = vi.fn();
    const c = await createDictationController({ onSegment: vi.fn(), onResumeActive });
    useDictationStore.setState({ status: "idle", phase: "active", enabled: true });
    // Tab-away first tears the relay down (arms the owner-resume guard), then focus returns.
    emit("dictation://focus", false);
    emit("dictation://focus", true);
    expect(useDictationStore.getState().status).toBe("listening");
    expect(onResumeActive).toHaveBeenCalledTimes(1);
    c.cleanup();
  });

  it("refocus (true) while PASSIVE does not resume a cloud stream", async () => {
    // Drop the block's own controller (beforeEach registered one) so only the controller this case
    // creates receives the broadcast. Targeted rather than purging the whole registry, which would
    // orphan `ctrl` and quietly turn its afterEach cleanup into a no-op. Double-cleanup is safe.
    ctrl.cleanup();
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

describe("per-window cloud-stream ownership on window-to-window switch (sparkle-ozvr)", () => {
  // The app-level dictation://focus never fires on a window-to-window switch (dictation.rs keeps the
  // app "focused" while any Sparkle window is up), so the OLD owner window's billable relay used to
  // keep streaming after the user moved to another window. notifyWindowFocus() is the per-window OS
  // focus signal (wired to DOM window focus/blur in the real webview) that closes that gap.
  beforeEach(() => {
    useDictationStore.setState({
      status: "listening",
      level: 0.6,
      speaking: true,
      interim: "live preview",
      phase: "active",
      enabled: true,
      error: null,
    });
  });

  it("the OWNER window losing focus tears down its billable relay (stops server metering)", async () => {
    const ctrl = await createDictationController({ onSegment: vi.fn() });
    invoke.mockClear();
    ctrl.notifyWindowFocus(false);
    const s = useDictationStore.getState();
    // The billable Deepgram relay is closed so it can't keep metering in the now-unfocused window.
    expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");
    expect(s.interim).toBe("");
    expect(s.level).toBe(0);
    expect(s.speaking).toBe(false);
    // Phase is RETAINED so refocusing the owner resumes without re-saying the wake word.
    expect(s.phase).toBe("active");
    ctrl.cleanup();
  });

  it("a PASSIVE (non-owner) window losing focus is a no-op (never opened a relay)", async () => {
    useDictationStore.setState({ phase: "passive" });
    const ctrl = await createDictationController({ onSegment: vi.fn() });
    invoke.mockClear();
    ctrl.notifyWindowFocus(false);
    expect(invoke).not.toHaveBeenCalledWith("stop_cloud_stream");
    ctrl.cleanup();
  });

  it("the owner regaining focus resumes its relay without a wake word", async () => {
    const onResumeActive = vi.fn();
    const ctrl = await createDictationController({ onSegment: vi.fn(), onResumeActive });
    ctrl.notifyWindowFocus(false); // switch away → torn down
    ctrl.notifyWindowFocus(true); // switch back → resumes
    expect(onResumeActive).toHaveBeenCalledTimes(1);
    expect(useDictationStore.getState().status).toBe("listening");
    ctrl.cleanup();
  });

  it("a torn-down owner resumes only ONCE even if focus fires repeatedly (dedupe)", async () => {
    const onResumeActive = vi.fn();
    const ctrl = await createDictationController({ onSegment: vi.fn(), onResumeActive });
    ctrl.notifyWindowFocus(false);
    ctrl.notifyWindowFocus(true);
    ctrl.notifyWindowFocus(true); // duplicate focus signal (e.g. DOM + app-level) → no second reopen
    expect(onResumeActive).toHaveBeenCalledTimes(1);
    ctrl.cleanup();
  });

  it("a BACKGROUND window does NOT grab the stream on an app-level refocus (only the focused one)", async () => {
    // Models the app tabbing away and back while a stale-active window sits in the background: its
    // isWindowActive() is false, so the broadcast dictation://focus must not make it reopen the relay.
    const onResumeActive = vi.fn();
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      onResumeActive,
      isWindowActive: () => false,
    });
    emit("dictation://focus", false); // arms the resume guard
    emit("dictation://focus", true); // app refocus, broadcast to every window
    expect(onResumeActive).not.toHaveBeenCalled();
    ctrl.cleanup();
  });

  it("DOM-focus and app-level focus firing together on app-return reopen the stream only once", async () => {
    const onResumeActive = vi.fn();
    const ctrl = await createDictationController({ onSegment: vi.fn(), onResumeActive });
    emit("dictation://focus", false); // tab-away arms the guard
    ctrl.notifyWindowFocus(true); // DOM focus resumes + disarms
    emit("dictation://focus", true); // app-level focus finds nothing left to do
    expect(onResumeActive).toHaveBeenCalledTimes(1);
    ctrl.cleanup();
  });
});

describe("multi-window level/speaking gate (background windows must not animate — sparkle-ozvr)", () => {
  beforeEach(() => {
    useDictationStore.setState({ level: 0, speaking: false, modelProgress: null });
  });

  it("a background window ignores dictation://level and dictation://speaking", async () => {
    const ctrl = await createDictationController({ onSegment: vi.fn(), isWindowActive: () => false });
    emit("dictation://level", 0.9);
    emit("dictation://speaking", true);
    expect(useDictationStore.getState().level).toBe(0);
    expect(useDictationStore.getState().speaking).toBe(false);
    ctrl.cleanup();
  });

  it("the focused window still drives level and speaking", async () => {
    const ctrl = await createDictationController({ onSegment: vi.fn(), isWindowActive: () => true });
    emit("dictation://level", 0.9);
    emit("dictation://speaking", true);
    expect(useDictationStore.getState().level).toBe(0.9);
    expect(useDictationStore.getState().speaking).toBe(true);
    ctrl.cleanup();
  });
});

describe("dictation://speech-end (the auto-send rail's silence signal)", () => {
  beforeEach(() => {
    useDictationStore.setState({ speechEndSeq: 0, speaking: false });
  });

  it("bumps speechEndSeq once per utterance, so two identical endings are two signals", async () => {
    const ctrl = await createDictationController({ onSegment: vi.fn(), isWindowActive: () => true });
    emit("dictation://speech-end", null);
    expect(useDictationStore.getState().speechEndSeq).toBe(1);
    // A COUNTER, not a flag: the second utterance ends exactly like the first, and a boolean that
    // was already true would be a state change nothing could subscribe to — the rail would arm on
    // the first sentence of a session and never again.
    emit("dictation://speech-end", null);
    expect(useDictationStore.getState().speechEndSeq).toBe(2);
    ctrl.cleanup();
  });

  it("a background window ignores it — a countdown there would press Send on another window's words", async () => {
    const ctrl = await createDictationController({ onSegment: vi.fn(), isWindowActive: () => false });
    emit("dictation://speech-end", null);
    expect(useDictationStore.getState().speechEndSeq).toBe(0);
    ctrl.cleanup();
  });

  it("is NOT inferable from dictation://speaking, which the cloud path pins true", async () => {
    const ctrl = await createDictationController({ onSegment: vi.fn(), isWindowActive: () => true });
    // The whole reason this event exists: on the cloud path dictation.rs holds `speaking` true for
    // the entire stream, so its edges say nothing about when a sentence ended.
    emit("dictation://speaking", true);
    emit("dictation://speaking", false);
    expect(useDictationStore.getState().speechEndSeq).toBe(0);
    ctrl.cleanup();
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
