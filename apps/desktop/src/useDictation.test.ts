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

const routeToTerminal = vi
  .fn()
  .mockResolvedValue({ kind: "delivered", agentId: "a1", text: "x" });
vi.mock("./services/dictationTerminalSink", () => ({
  routeDictationToTerminal: (...a: unknown[]) => routeToTerminal(...a),
}));

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

// ---------------------------------------------------------------------------
// Modules under test (imported after mocks are registered)
// ---------------------------------------------------------------------------
import { useDictationStore } from "./stores/dictationStore";
import { useDictationEngineStore } from "./stores/dictationEngineStore";
import { useAuthStore } from "./stores/authStore";
import { useUiStore } from "./stores/uiStore";
import {
  createDictationController,
  cloudStreamCommandFor,
  IDLE_RELAY_PARK_MS,
} from "./useDictation";
import type { FocusOwner } from "./voice/dictationFocus";

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

/** Stands in for the real hook (useAmbientVoice): runs the phase machine, inserts composer-bound
 *  text itself, and hands terminal-bound text BACK for the controller to type. `survives` models
 *  what the wake/stop stripping left behind — `""` is a phrase that was purely a stop word. */
function phaseMachine(survives?: string) {
  return vi.fn((text: string, ctx: { terminal: boolean }) =>
    ctx.terminal ? (survives ?? text) : undefined,
  );
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
      // The FOURTH fixture to need these (roborev 57296), and this one is worse than the three
      // already corrected: a row below writes `focusOwner: "terminal"`, and `setFocusOwner` is a
      // documented NO-OP when the value is unchanged — so a leaked "terminal" makes a later row's
      // own setup silently do nothing and the branch it means to exercise never runs. That fails
      // OPEN: the row passes while testing the wrong path.
      windowFocused: true,
      focusOwner: "other",
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
      // The FOURTH fixture to need these (roborev 57296), and this one is worse than the three
      // already corrected: a row below writes `focusOwner: "terminal"`, and `setFocusOwner` is a
      // documented NO-OP when the value is unchanged — so a leaked "terminal" makes a later row's
      // own setup silently do nothing and the branch it means to exercise never runs. That fails
      // OPEN: the row passes while testing the wrong path.
      windowFocused: true,
      focusOwner: "other",
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
    expect(onSegment).toHaveBeenCalledWith("hello world", { terminal: false });
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
    // The interim starts EMPTY here on purpose. This row is about the handoff — preview cleared,
    // backend told to resume on-device — and it used to seed a "stale ghost" to prove the clear.
    // That premise is now false: a non-empty interim at this instant is the user's uncommitted tail,
    // not a ghost, and it is recovered rather than discarded (see the tail-recovery block below).
    // Seeding one here would make this row silently assert the OPPOSITE of the fix.
    useDictationStore.setState({ interim: "" });
    invoke.mockClear();
    emit("dictation://cloud-ended", null);
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
  /** The SAME watchdog's other report — macOS handing the process zeros on a grant it calls live.
   *  A second kind, one emitter: the all-clear has to retract this one too. */
  const STALE_GRANT_ERROR =
    `macOS is sending silence instead of audio from "MacBook Pro Microphone", even though ` +
    `Sparkle's microphone permission looks granted. Quit Sparkle and open it again — that usually ` +
    `re-establishes the grant.`;
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

  it("retracts the STALE-GRANT report too — it is the same watchdog (knightwatch probe 1)", () => {
    // The seam this asserts drifted the moment a second watchdog kind was added: both ends of the
    // retraction tested `classifyVoiceError(...) === "no-audio"`, so a stale-grant report latched
    // no fault, the all-clear early-returned on `!deadMicSilent`, and the notice stayed up over a
    // microphone that had recovered — with the mic drawn as paused until the user cycled it.
    //
    // Asserted on the OUTPUT of the recovery (notice gone, mic listening again), not on the flag:
    // a version that latched the fault but still refused to clear the notice would pass a
    // `deadMicSilent === true` assertion while shipping the visible half of the bug.
    emit("dictation://error", STALE_GRANT_ERROR);
    expect(useDictationStore.getState().error).toBe(STALE_GRANT_ERROR);
    expect(useDictationStore.getState().status).toBe("error");

    emit("dictation://audio-recovered", null);
    expect(useDictationStore.getState().error).toBeNull();
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
    expect(onSegment).toHaveBeenCalledWith("hello world", { terminal: false });
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
    expect(activeSeg).toHaveBeenCalledWith("type me once", { terminal: false });
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

  // ══ THE FALLBACK NOTICE IS PER-WINDOW TOO — AND ONLY ONE WINDOW CAN EVER CLEAR IT ══════════════
  // `dictation://cloud-ended` is an app-wide broadcast and every project window mounts its own
  // DictationEngineBanner (Workspace.tsx). This handler reported the fallback UNGATED, so one relay
  // death lit the bar in EVERY open window — while `noteCloudLive` only ever fires in the window
  // that reopens the stream. The others had no path back at all: the founder would have to dictate
  // into each window separately to clear a notice none of them had earned. Same defect the level
  // meter already had (sparkle-ozvr), on the same broadcast, one listener away.

  it("a background window does not claim the fallback from another window's relay death", async () => {
    useDictationEngineStore.setState({
      fallbackReason: null,
      dismissed: false,
      observedAt: null,
      openRefusals: 0,
    });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => false,
    });
    try {
      emit("dictation://cloud-ended", false);
      // Not this window's dictation, so not this window's banner.
      expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
    } finally {
      // UNCONDITIONAL: cleanup() unsubscribes this controller's `useDictationStore` subscriber, and
      // the file-level beforeEach only clears the EVENT bus — it cannot reach a zustand
      // subscription. A cleanup skipped by a failing assertion therefore leaks a live controller
      // into every later test in the file, where it answers a `setPhase` by invoking
      // `stop_cloud_stream` and reds two unrelated terminal-routing rows. Cost me one debugging
      // round; try/finally is what makes the red phase of TDD safe here.
      ctrl.cleanup();
    }
  });

  it("the window that was actually dictating DOES report the fallback", async () => {
    useDictationEngineStore.setState({
      fallbackReason: null,
      dismissed: false,
      observedAt: null,
      openRefusals: 0,
    });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
    });
    try {
      emit("dictation://cloud-ended", false);
      expect(useDictationEngineStore.getState().fallbackReason).toBe(
        "unavailable",
      );
    } finally {
      ctrl.cleanup();
    }
  });

  // ══ THE BANNER MUST NOT STAND OVER A WORKING LIVE PREVIEW ══════════════════════════════════════
  // `start_cloud_stream` returns a bare bool meaning "I opened a socket", and `cloud_reuse` answers
  // `AlreadyRouting` → `Ok(false)` for a socket that is ALIVE, matches the project and is actively
  // routing. The frontend reads that `false` as a refusal, so a repeated passive→active edge or a
  // focus-regain onto a warm socket raises "Sparkle can't reach the cloud transcription service"
  // while relay text is arriving. An interim can only come from the relay — the on-device engine has
  // none — so it is the evidence that settles it.

  it("out-of-credits still reaches a window that is NOT capturable — it is not window-scoped", async () => {
    // roborev 59964. The per-window gate fixes over-reporting but opens the opposite gap: a
    // teardown landing after focus moved is reported by NO window. For an ordinary outage that is
    // fine (the next attempt re-reports it). For `exhausted` it is not — the balance refresh beside
    // it is ungated, so the credits pill would drop to zero with nothing anywhere saying why, and
    // refilling is the one remedy the user can act on.
    useDictationEngineStore.setState({
      fallbackReason: null,
      dismissed: false,
      observedAt: null,
      openRefusals: 0,
    });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => false,
    });
    try {
      emit("dictation://cloud-ended", true);
      expect(useDictationEngineStore.getState().fallbackReason).toBe("exhausted");
    } finally {
      ctrl.cleanup();
    }
  });

  it("a healthy session never accumulates corroboration — an interim clears a partial count", async () => {
    // roborev 59964/59966, and the finding that broke my original premise. `cloud_reuse` answers
    // `AlreadyRouting -> Ok(false)` on EVERY passive→active edge onto a warm socket, so consecutive
    // no-ops are the NORMAL case; the counter climbed through a healthy session because nothing
    // reset it while no notice was painted, and two holds onto one live socket then raised the
    // banner over visibly streaming relay text.
    useDictationEngineStore.setState({
      fallbackReason: null,
      dismissed: false,
      observedAt: null,
      openRefusals: 0,
    });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
    });
    try {
      // A no-op refusal, then the stream it was a no-op FOR proves itself, then another no-op.
      useDictationEngineStore.getState().noteCloudOpenRefused();
      emit("dictation://interim", "the relay is plainly alive");
      expect(useDictationEngineStore.getState().openRefusals).toBe(0);

      useDictationEngineStore.getState().noteCloudOpenRefused();

      // Two refusals total, an interim between them: no verdict, no banner.
      expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
    } finally {
      ctrl.cleanup();
    }
  });

  it("TERMINAL dictation discharges corroboration too — evidence is not about the destination", async () => {
    // roborev 59975. The counter is FED under `isCapturable()` but was CLEARED under
    // `isRoutable()`, and those disagree on exactly one supported mode: caret in a terminal with
    // routing armed makes `isTerminalRoutable()` true, so `isCapturable()` is true while
    // `isRoutable()` is false. Terminal dictation therefore banked refusals it could never
    // discharge and would raise the banner over a live relay — the same flap, surviving in the one
    // mode the earlier fix did not reach.
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "active",
      focusOwner: "terminal",
    });
    useDictationEngineStore.setState({
      fallbackReason: null,
      dismissed: false,
      observedAt: null,
      openRefusals: 1,
    });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    try {
      emit("dictation://interim", "spoken straight into the terminal");

      expect(useDictationEngineStore.getState().openRefusals).toBe(0);
    } finally {
      ctrl.cleanup();
      useDictationStore.setState({ phase: "passive", focusOwner: "other" });
    }
  });

  it("a relay interim retires a standing fallback notice — the preview is demonstrably working", async () => {
    useDictationEngineStore.setState({
      fallbackReason: "unavailable",
      dismissed: false,
      observedAt: Date.now(),
    });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
    });
    try {
      emit("dictation://interim", "these words came from the relay");

      expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
    } finally {
      ctrl.cleanup();
    }
  });

  it("a background window's interim does not retire the notice (it never painted one either)", async () => {
    useDictationEngineStore.setState({
      fallbackReason: "unavailable",
      dismissed: false,
      observedAt: Date.now(),
    });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => false,
    });
    try {
      emit("dictation://interim", "another window's words");

      // Same ONE GATE as everywhere else: a window dictation is not routing into makes no claim
      // about the engine in either direction.
      expect(useDictationEngineStore.getState().fallbackReason).toBe(
        "unavailable",
      );
    } finally {
      ctrl.cleanup();
    }
  });

  it("one relay death, two windows: exactly ONE of them reports it", async () => {
    useDictationEngineStore.setState({
      fallbackReason: null,
      dismissed: false,
      observedAt: null,
      openRefusals: 0,
    });
    // Count the REPORTS, not the resulting state. Both controllers share one module-level store in
    // this harness, so "fallbackReason === 'exhausted'" is satisfied by one window or by both — it
    // cannot tell the fix from the bug. The call count can.
    //
    // mockImplementation(() => {}), NOT a call-through: the real action runs zustand's `set`, which
    // swaps the state OBJECT the spy was installed on. The second controller's `getState()` would
    // then return a fresh object without the spy, so a call-through would record 1 call even with
    // the gate absent — a vacuous green.
    const report = vi
      .spyOn(useDictationEngineStore.getState(), "noteCloudUnavailable")
      .mockImplementation(() => {});
    const active = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
    });
    const background = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => false,
    });
    try {
      // ONE backend emission, fanned out to both windows' listeners (real Tauri behavior).
      // `false` (an ordinary outage) on purpose: `exhausted` is deliberately NOT window-scoped —
      // see the exhausted case below — so it would legitimately report twice here.
      emit("dictation://cloud-ended", false);

      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith("unavailable");
    } finally {
      report.mockRestore();
      active.cleanup();
      background.cleanup();
    }
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

  it("bumps committedSeq on every ARRIVED segment — the push-to-talk drain's only signal", async () => {
    // ── roborev 57307 ─────────────────────────────────────────────────────────────────────────────
    // The release drain settles on "has anything landed since the release", and `committedSeq` is
    // the whole of that signal. Nothing tested that this handler bumps it: the hook-level rows in
    // useSendMode.test.ts bump the counter BY HAND in their fixture, so deleting this production
    // call left the entire suite green while every release with an outstanding run fell to the 4s
    // cap — which is also the truncating path for an utterance still trickling in.
    // DELTAS, not absolutes: this suite shares one module-level store and does not reset the
    // counter, so an absolute expectation would encode how many rows happen to run first.
    const seq = () => useDictationStore.getState().committedSeq;
    const ctrl = await createDictationController({ onSegment: vi.fn(), isWindowActive: () => true });
    const before = seq();
    emit("dictation://partial", "hello world");
    expect(seq() - before).toBe(1);
    // A COUNTER, not a flag — the drain restarts its quiet window on each arrival, so two segments
    // have to be two signals even when the text is identical.
    emit("dictation://partial", "hello world");
    expect(seq() - before).toBe(2);
    ctrl.cleanup();
  });

  it("bumps it on the TERMINAL route too — the branch the composer rows can never reach", async () => {
    // ── roborev 57319 ─────────────────────────────────────────────────────────────────────────────
    // `dictation://partial` has TWO bump sites, and both other rows drive only the composer one:
    // neither passes `focusOwner`, so it falls back to reading the DOM, jsdom classifies
    // `document.body` as "other", `isTerminalRoutable()` is false, and control always reaches the
    // composer branch. Deleting the terminal bump left the whole suite green.
    //
    // That call site is not decorative. With the caret in a routable terminal the phrase is typed
    // into the PTY and the composer never moves, so `committedSeq` is the ONLY arrival signal the
    // push-to-talk drain has on that path — losing it pins `quietSince` at null forever and sends
    // every release with an outstanding run to the 4s cap, which is the truncating path.
    const seq = () => useDictationStore.getState().committedSeq;
    const ctrl = await createDictationController({
      onSegment: vi.fn(() => "type me"),
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    // The state `terminalRoutingArmed()` requires: armed, woken, not errored.
    useDictationStore.setState({ enabled: true, phase: "active", status: "idle" });
    const before = seq();
    emit("dictation://partial", "restart the server");
    expect(seq() - before, "the terminal route must record the arrival too").toBe(1);
    ctrl.cleanup();
  });

  it("does NOT bump it in a background window — the negative that makes the row above mean something", async () => {
    // Without this, nothing distinguishes "bumped on ARRIVAL" from "bumped on every broadcast".
    // `dictation://partial` reaches EVERY window; only the one dictation may route into consumes it,
    // and a background window bumping the counter would settle a release in a window that never
    // heard the words. Mirrors the speechEndSeq treatment directly below.
    const seq = () => useDictationStore.getState().committedSeq;
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => false,
    });
    const before = seq();
    emit("dictation://partial", "hello world");
    expect(seq() - before).toBe(0);
    ctrl.cleanup();
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

  it("is NOT inferable from dictation://speaking, which is a raw level and not an utterance boundary", async () => {
    const ctrl = await createDictationController({ onSegment: vi.fn(), isWindowActive: () => true });
    // The whole reason this event exists: `speaking` is the VAD's real-time level, so its falling
    // edge means "quiet for a frame", not "the sentence ended" — it drops on every inter-word gap and
    // says nothing about the boundary the rail needs. (It formerly ALSO stayed pinned true for a
    // whole cloud stream; the 2026-07-29 dead-mic fix removed that, but the conclusion is the same
    // and the assertion below is unchanged — see roborev 55503.)
    emit("dictation://speaking", true);
    emit("dictation://speaking", false);
    expect(useDictationStore.getState().speechEndSeq).toBe(0);
    ctrl.cleanup();
  });
});

// The relay's lifetime now hangs off the PHASE EDGE rather than off a wake/stop transition, because
// segments cannot move the phase any more — the tray is its only writer. Keyed on the old shape this
// would never fire again, i.e. Speak would arm a microphone whose cloud stream never opened.
describe("cloudStreamCommandFor (the phase edge owns the relay)", () => {
  it("opens the cloud stream on passive → active (entering Speak, or a push-to-talk hold)", () => {
    expect(cloudStreamCommandFor("passive", "active")).toBe("start_cloud_stream");
  });

  it("closes it on active → passive (leaving Speak, or the hold ending)", () => {
    expect(cloudStreamCommandFor("active", "passive")).toBe("stop_cloud_stream");
  });

  it("does nothing when the phase did not actually change", () => {
    // Load-bearing: this subscriber runs on EVERY store update (levels arrive ~25x/sec), so a
    // re-observation of an unchanged phase must not re-handshake the billable relay.
    expect(cloudStreamCommandFor("active", "active")).toBeNull();
    expect(cloudStreamCommandFor("passive", "passive")).toBeNull();
  });
});

// NOTE: the real routing gate is exercised end-to-end through `useAmbientVoice` in
// useDictation.arm.test.tsx. What used to sit here re-implemented the wake machine inline (calling
// `advance` and applying its result by hand), which proved nothing about the hook — see the header
// on that file's terminal-path block, and roborev 56056 for the mutation it let through.

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
    expect(a).toHaveBeenCalledWith("seg", { terminal: false });
    expect(b).toHaveBeenCalledWith("seg", { terminal: false });

    ctrlA.cleanup();
    ctrlB.cleanup();
  });
});

describe("dictation follows focus — the caret in a TERMINAL redirects routing", () => {
  // THE REGRESSION THIS BLOCK EXISTS FOR. The mic used to keep transcribing while the caret sat in
  // a terminal: words landed in a composer the user was not looking at, the auto-send rail never
  // armed, and nothing on screen said why. Two subsystems disagreeing about the active target is
  // exactly the half-state the one gate (`isRoutable`) was introduced to make unrepresentable.
  //
  // Every test below drives the REAL listeners through the injected `focusOwner` seam and asserts
  // the SIDE EFFECT — a segment not delivered, a seq not bumped — never a precondition.
  beforeEach(() => {
    useDictationStore.setState({
      interim: "",
      modelProgress: null,
      speechEndSeq: 0,
      enabled: true,
      status: "listening",
      phase: "active",
    });
  });

  // ── ARMING is not a focus transition, which is how the half-state survived ────────────────────
  // The gate above is driven by focus CHANGES. Clicking the mic changes no focus, so these two paths
  // asserted "listening" outright and produced the contradiction inverted: nothing routed, while
  // both surfaces read `status === "listening"` as `passiveWaiting` and printed "Mic paused. Say Hey
  // Sparkle to activate" — an invitation to speak into a pipeline that discards every word, with the
  // terminal copy suppressed because it only renders under `focusPaused` (roborev 55497).
  //
  // Both assert `status`, which is the INPUT deriveMicPresentation reads to choose the copy, and both
  // fail against the previous code, which wrote "listening" unconditionally on these paths.

  it("arming with the caret in a terminal that CAN take the phrase reads as listening", async () => {
    // The complement of the case below, and why `armedStatus` had to grow its second term. With
    // dictation woken, a committed phrase is TYPED at that agent's input line — so "paused" would
    // describe the exact opposite of what the app is about to do.
    useDictationStore.setState({ enabled: true, status: "idle", phase: "active" });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    await ctrl.toggle();
    expect(useDictationStore.getState().status).toBe("listening");
    ctrl.cleanup();
  });

  it("arming while the caret is in a terminal that CANNOT take the phrase reads as paused", async () => {
    // The pre-arm shape: armed by the user (`enabled` true — that is the mic button's own state and
    // `toggle` deliberately never writes it), status not yet settled. `toggle()` takes the arm branch.
    // `enabled` must be true here or deriveMicPresentation short-circuits to "off" and the paused copy
    // is moot — "off" and "paused" are different claims and only the second one needs a cause.
    // `phase: "passive"` is load-bearing and was previously left to whatever the store happened to
    // hold: it is THE WAKE GATE, and it is the reason this terminal is not a destination. Without it
    // the fixture drifts into the routing case above and this test asserts the opposite of the code.
    useDictationStore.setState({ enabled: true, status: "idle", phase: "passive" });
    // MUTABLE on purpose: the caret has to be able to actually leave. A constant `() => "terminal"`
    // would keep `isRoutable()` false forever, so the resume half below could never fire and the
    // "recoverable" claim would be untestable — passing only because nothing ran.
    let owner: FocusOwner = "terminal";
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => owner,
    });
    await ctrl.toggle();
    // THE ASSERTION. "listening" here is what painted the false invitation; anything else routes the
    // surfaces through `focusPaused`, the one presentation that states the CAUSE.
    expect(useDictationStore.getState().status).toBe("idle");
    // …and the arm genuinely happened — this must be a PAUSE, not a refusal to arm. Capture really
    // starts, and `enabled` is left exactly as the user set it, so this can never be read as a mute.
    expect(invoke).toHaveBeenCalledWith("start_dictation");
    expect(useDictationStore.getState().enabled).toBe(true);
    // And the mic is not stuck there: the existing focus-owner path restores it on the way out,
    // proving the pause is recoverable by moving the caret alone — no second click on the mic.
    owner = "other";
    ctrl.notifyFocusOwner("other");
    expect(useDictationStore.getState().status).toBe("listening");
    ctrl.cleanup();
  });

  it("arming with the caret in the composer still claims listening (the fix must not mute the normal case)", async () => {
    // The other half of the pin. Without this, `armedStatus` returning "idle" unconditionally would
    // satisfy the test above while breaking every ordinary arm — the mic would never claim to listen.
    useDictationStore.setState({ enabled: true, status: "idle" });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    await ctrl.toggle();
    expect(useDictationStore.getState().status).toBe("listening");
    ctrl.cleanup();
  });

  it("the watchdog's all-clear does NOT re-claim listening while the caret is in a terminal", async () => {
    // Second path to the same contradiction. Frames stopped, the user was told, they fixed it — and
    // recovery arrived while the caret was parked in a terminal. The sibling dictation://focus(true)
    // handler already carried the terminal term; this one did not, so it flipped the UI back to
    // claiming live capture over a gate that keeps dropping everything.
    useDictationStore.setState({ enabled: true, status: "error", error: null, deadMicSilent: true });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    emit("dictation://audio-recovered", null);
    expect(useDictationStore.getState().status).not.toBe("listening");
    ctrl.cleanup();
  });

  it("the watchdog's all-clear DOES restore listening once the caret is back in the composer", async () => {
    // Guards the fix from over-reaching: the recovery path must still do its job in the normal case,
    // or a recovered mic stays drawn as paused until the user cycles it by hand.
    useDictationStore.setState({ enabled: true, status: "error", error: null, deadMicSilent: true });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    emit("dictation://audio-recovered", null);
    expect(useDictationStore.getState().status).toBe("listening");
    ctrl.cleanup();
  });

  it("a committed partial is aimed at the PTY, not the composer, while the caret is in a terminal", async () => {
    // It used to be DROPPED here, which is what this feature replaces. It is now REDIRECTED: the
    // phase machine still sees it (so the stop word works), but bound for the terminal.
    useDictationStore.setState({ phase: "active", enabled: true, status: "idle" });
    const onSegment = phaseMachine();
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    emit("dictation://partial", "this belongs to the PTY, not the composer");
    expect(onSegment).toHaveBeenCalledWith("this belongs to the PTY, not the composer", {
      terminal: true,
    });
    ctrl.cleanup();
  });

  it("…and is delivered again the moment the caret leaves the terminal", async () => {
    const onSegment = vi.fn();
    // A mutable seam, so ONE controller sees the caret move — the real sequence a user performs.
    let owner: "terminal" | "other" = "terminal";
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => true,
      focusOwner: () => owner,
    });
    // `phase: "passive"` — un-woken, so the terminal is NOT a destination and the phrase really is
    // swallowed. Without this the caret-in-terminal case now REDIRECTS, and the test would be
    // asserting the opposite of the feature.
    useDictationStore.setState({ phase: "passive", enabled: true, status: "idle" });
    emit("dictation://partial", "swallowed");
    expect(onSegment).not.toHaveBeenCalled();
    owner = "other";
    emit("dictation://partial", "delivered");
    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment).toHaveBeenCalledWith("delivered", { terminal: false });
    ctrl.cleanup();
  });

  it("speech-end does NOT arm the auto-send clock while the caret is in a terminal", async () => {
    // `speechEndSeq` is the ONLY thing that starts the countdown (voice/useAutoSend). A bump here
    // would count down over a composer the user is not typing into and then press Send.
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    emit("dictation://speech-end", null);
    expect(useDictationStore.getState().speechEndSeq).toBe(0);
    ctrl.cleanup();
  });

  it("speech-end arms normally once the caret is back out of the terminal", async () => {
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    emit("dictation://speech-end", null);
    expect(useDictationStore.getState().speechEndSeq).toBe(1);
    ctrl.cleanup();
  });

  it("ONE GATE PER DESTINATION: the rail arms for the composer and NEVER for a terminal", async () => {
    // ══ THIS INVARIANT DELIBERATELY CHANGED ═══════════════════════════════════════════════════
    // It used to read "text and speech-end are never in disagreement", which was right while a
    // terminal was a dead end: nothing routed there, so nothing armed either. Now the text DOES
    // route to a terminal while the rail must still NEVER arm for one — because the rail is what
    // presses Enter, and the whole contract is that a human does that. So the two are the same
    // decision only on the composer path, and the asymmetry is the feature, not a re-split gate.
    useDictationStore.setState({ phase: "active", enabled: true, status: "idle" });
    for (const owner of ["terminal", "other"] as const) {
      useDictationStore.setState({ speechEndSeq: 0 });
      const onSegment = phaseMachine();
      const ctrl = await createDictationController({
        onSegment,
        isWindowActive: () => true,
        focusOwner: () => owner,
      });
      emit("dictation://partial", "words");
      emit("dictation://speech-end", null);
      // The text ALWAYS lands somewhere, and the destination is the one the caret implies…
      expect(onSegment).toHaveBeenCalledWith("words", { terminal: owner === "terminal" });
      // …but the clock that would press Enter arms ONLY for the composer. This is the assertion
      // that keeps a dictated phrase from ever being SUBMITTED into a live agent.
      expect(useDictationStore.getState().speechEndSeq).toBe(owner === "other" ? 1 : 0);
      ctrl.cleanup();
    }
  });

  it("a disarmed mic is OFF, not terminal-paused — routing is unaffected by the caret", async () => {
    // dictationPauseReason returns null when `enabled` is false, so nothing about a muted mic
    // should start depending on where the caret happens to be. (`isWindowActive` still gates, as
    // it always did — that term is about which window consumes the broadcast, not about pausing.)
    useDictationStore.setState({ enabled: false });
    const onSegment = vi.fn();
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    emit("dictation://partial", "still routed — the pause is a dictation concept");
    expect(onSegment).toHaveBeenCalledTimes(1);
    ctrl.cleanup();
  });

  it("moving the caret into a terminal that CAN take the phrase keeps the billable relay UP", async () => {
    // THE FEATURE, stated as the thing that must NOT happen. Tearing the relay down here is exactly
    // what made a terminal caret a dead end: with no stream there is no transcription, so there is
    // nothing left to type and the routing below could never fire. This is the assertion that would
    // catch a well-meaning "restore the pause" change.
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    // `focusOwner: "other"` first, deliberately: the controller subscribes to a CHANGE, and no hook
    // resets this field between tests — a fixture that starts already on "terminal" silently tests
    // nothing, because the subscription never fires.
    useDictationStore.setState({ phase: "active", enabled: true, status: "idle", focusOwner: "other" });
    invoke.mockClear();
    useDictationStore.getState().setFocusOwner("terminal");
    expect(invoke).not.toHaveBeenCalledWith("stop_cloud_stream");
    // …and the UI says so, rather than going quiet over a live capture.
    expect(useDictationStore.getState().status).toBe("listening");
    ctrl.cleanup();
  });

  it("a committed phrase is TYPED INTO THE TERMINAL and never reaches the composer", async () => {
    // The two destinations must stay mutually exclusive — the same phrase landing in both is the
    // failure `isRoutable`'s `!isTerminalRoutable()` term exists to prevent.
    useDictationStore.setState({ phase: "active", enabled: true, status: "idle" });
    const onSegment = phaseMachine();
    routeToTerminal.mockClear();
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    emit("dictation://partial", "run the tests again");
    expect(routeToTerminal).toHaveBeenCalledWith("run the tests again");
    ctrl.cleanup();
  });

  // ══ THE STOP WORD MUST STILL WORK IN A TERMINAL (roborev 56038) ════════════════════════════
  // `onSegment` is the ONLY driver of the wake/stop machine. Bypassing it on the terminal path meant
  // the stop word was TYPED onto the agent's command line instead of ending the session — while the
  // composer placeholder was telling the user to say it, and `phase` could never return to passive,
  // so the billable relay had no voice way to close.
  it("hands terminal-bound segments to the phase machine rather than around it", async () => {
    useDictationStore.setState({ phase: "active", enabled: true, status: "idle" });
    const onSegment = phaseMachine();
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    emit("dictation://partial", "keep going");
    expect(onSegment).toHaveBeenCalledWith("keep going", { terminal: true });
    ctrl.cleanup();
  });

  it("types NOTHING when the phrase was consumed entirely by a stop word", async () => {
    useDictationStore.setState({ phase: "active", enabled: true, status: "idle" });
    routeToTerminal.mockClear();
    const ctrl = await createDictationController({
      onSegment: phaseMachine(""), // the machine kept nothing back
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    emit("dictation://partial", "that is all");
    expect(routeToTerminal).not.toHaveBeenCalled();
    ctrl.cleanup();
  });

  // ══ A REFUSAL MUST NOT SWALLOW THE WORDS ═══════════════════════════════════════════════════
  it("leaves the phrase in the composer when the terminal refuses it", async () => {
    useDictationStore.setState({ phase: "active", enabled: true, status: "idle" });
    // Through `insertTarget`, the REAL mechanism, rather than by replacing the `insert` action:
    // `insert` is a silent no-op when no compose box has registered a target, so a hand-installed
    // spy proves the call happened while proving nothing about whether the text landed anywhere
    // (roborev 56057).
    const insert = vi.fn();
    useDictationStore.setState({ insertTarget: insert });
    routeToTerminal.mockClear();
    routeToTerminal.mockResolvedValueOnce({
      kind: "refused",
      agentId: "a1",
      reason: "awaiting-input",
    });
    const ctrl = await createDictationController({
      onSegment: phaseMachine(),
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    emit("dictation://partial", "yes please");
    // The delivery is awaited inside the listener's promise chain, so let it settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(insert).toHaveBeenCalledWith("yes please");
    ctrl.cleanup();
  });

  it("does not claim a composer placement when no compose box is mounted to catch it", async () => {
    // `insertTarget` is ONE app-wide slot and can be null — in which case the fallback silently
    // dropped the phrase while logging that it had left it in the composer, re-creating the exact
    // silent loss the fallback exists to close, and lying about it in the same breath.
    useDictationStore.setState({ phase: "active", enabled: true, status: "idle", insertTarget: null });
    routeToTerminal.mockClear();
    routeToTerminal.mockResolvedValueOnce({
      kind: "refused",
      agentId: "a1",
      reason: "awaiting-input",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const ctrl = await createDictationController({
      onSegment: phaseMachine(),
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    emit("dictation://partial", "yes please");
    await new Promise((r) => setTimeout(r, 0));
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("no composer was mounted"),
      expect.anything(),
    );
    info.mockRestore();
    ctrl.cleanup();
  });

  it("THE WAKE GATE: an armed but un-woken mic types nothing into the terminal", async () => {
    // Typing into a live agent is sharper than filling a compose box the user can read before
    // sending, so it requires that dictation was actually woken — not merely left armed near an
    // open terminal. Neither destination may receive the phrase in this state.
    useDictationStore.setState({ phase: "passive", enabled: true, status: "idle" });
    const onSegment = vi.fn();
    routeToTerminal.mockClear();
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    emit("dictation://partial", "rm -rf node_modules");
    expect(routeToTerminal).not.toHaveBeenCalled();
    expect(onSegment).not.toHaveBeenCalled();
    ctrl.cleanup();
  });

  // ══ THE PHASE EDGE OPENS THE RELAY — EXACTLY ONCE (roborev 56061, re-aimed) ════════════════
  // This case used to assert the OPPOSITE: that a phase edge must NOT touch the stream. That was
  // right while the SEGMENT HANDLER opened the relay on the wake word, because reconciling through
  // the focus handler re-entered the resume path in the same tick — two handshakes, and the relay
  // debits a first minute UP FRONT, so the user paid twice for one wake word.
  //
  // With the wake word retired, segments cannot move the phase at all, so there is no second opener
  // left to race — and if this edge stayed inert the relay would never open at all: Speak would arm
  // a microphone with no cloud stream behind it. The edge is now the single opener, and what still
  // has to hold is that it fires ONCE per edge, not once per store update (levels arrive ~25x/sec).
  it("opens the billable relay exactly ONCE per phase edge", async () => {
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "passive",
      focusOwner: "other",
    });
    // `onResumeActive` IS the relay-open callback (the hook wires it to openCloudDictationWindow),
    // so it is the observable this layer actually owns. Asserting on `start_cloud_stream` here would
    // be vacuous: the controller never invokes it — the hook does.
    const onResumeActive = vi.fn();
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      onResumeActive,
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    onResumeActive.mockClear();
    // Entering Speak (or beginning a push-to-talk hold): the mic intent writes the phase, and that
    // edge is what opens the relay.
    useDictationStore.getState().setPhase("active");
    expect(onResumeActive).toHaveBeenCalledTimes(1);
    // Further store updates that do NOT change the phase must not re-handshake it. `setLevel` is the
    // realistic one: it fires ~25x/sec for the whole capturing window, through this same subscriber.
    useDictationStore.getState().setLevel(0.4);
    useDictationStore.getState().setLevel(0.7);
    useDictationStore.getState().setPhase("active");
    expect(onResumeActive).toHaveBeenCalledTimes(1);
    ctrl.cleanup();
  });

  // ══ THE CLOSE SIDE OF THE PHASE EDGE, AND ITS WINDOW GUARD (roborev 57785) ═════════════════
  // The open side had a case; the close side had none, and neither did the `isWindowActive()` term
  // on it — so deleting that guard, or the whole `else if` branch, left the suite green while a
  // background window closed the relay the focused one had just opened. That is exactly the
  // "a guard whose removal no test can detect" pattern useDictation.ts warns about two paragraphs
  // above the code these cover.
  it("closes the billable relay when the phase leaves ACTIVE", async () => {
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "active",
      focusOwner: "other",
    });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    invoke.mockClear();
    useDictationStore.getState().setPhase("passive");
    expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");
    ctrl.cleanup();
  });

  it("does NOT close it from a window that is not the focused dictation target", async () => {
    // `phase` is persisted and CROSS-WINDOW SYNCED, so one tray gesture in ONE window runs this
    // subscriber in EVERY window. Without the guard, a background window calls `stop_cloud_stream`
    // on the single global relay the focused window owns.
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "active",
      focusOwner: "other",
    });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => false,
      focusOwner: () => "other",
    });
    invoke.mockClear();
    useDictationStore.getState().setPhase("passive");
    expect(invoke).not.toHaveBeenCalledWith("stop_cloud_stream");
    ctrl.cleanup();
  });

  // ══ THE IDLE PARK — SILENCE MUST NOT KEEP PAYING FOR A SOCKET (roborev 57785, High) ═════════
  // Both closers of the relay went with the wake word (the stop word, and pause-on-submit), so
  // "Speak is always on" left the billable socket open through arbitrary silence — metered per
  // ELAPSED minute, debited up front. These pin the replacement.
  it("parks the relay after a minute of silence, without disarming the mic", async () => {
    vi.useFakeTimers();
    try {
      useDictationStore.setState({
        enabled: true,
        status: "listening",
        phase: "active",
        focusOwner: "other",
        speaking: true,
      });
      const ctrl = await createDictationController({
        onSegment: vi.fn(),
        isWindowActive: () => true,
        focusOwner: () => "other",
      });
      invoke.mockClear();
      // The user stops talking. Nothing should happen yet — a pause is not the end of a session.
      useDictationStore.getState().setSpeaking(false);
      vi.advanceTimersByTime(IDLE_RELAY_PARK_MS - 1_000);
      expect(invoke).not.toHaveBeenCalledWith("stop_cloud_stream");
      // …and then the clock runs out.
      vi.advanceTimersByTime(2_000);
      expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");
      // THE MICROPHONE IS UNTOUCHED, which is the whole point: "always on" is about the mic, not
      // the socket. Asserting this is what stops a future "fix" from parking by disarming.
      const st = useDictationStore.getState();
      expect(st.enabled).toBe(true);
      expect(st.phase).toBe("active");
      ctrl.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a word before the minute is up cancels the park entirely", async () => {
    vi.useFakeTimers();
    try {
      useDictationStore.setState({
        enabled: true,
        status: "listening",
        phase: "active",
        focusOwner: "other",
        speaking: true,
      });
      const ctrl = await createDictationController({
        onSegment: vi.fn(),
        isWindowActive: () => true,
        focusOwner: () => "other",
      });
      invoke.mockClear();
      useDictationStore.getState().setSpeaking(false);
      vi.advanceTimersByTime(IDLE_RELAY_PARK_MS - 5_000);
      // He starts talking again mid-thought. An ordinary pause must not cost him the socket.
      useDictationStore.getState().setSpeaking(true);
      vi.advanceTimersByTime(IDLE_RELAY_PARK_MS * 2);
      expect(invoke).not.toHaveBeenCalledWith("stop_cloud_stream");
      ctrl.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms the park when a resume reopens the relay — the alt-tab path", async () => {
    vi.useFakeTimers();
    try {
      useDictationStore.setState({
        enabled: true,
        status: "listening",
        phase: "active",
        focusOwner: "other",
        speaking: true,
      });
      const ctrl = await createDictationController({
        onSegment: vi.fn(),
        onResumeActive: vi.fn(),
        isWindowActive: () => true,
        focusOwner: () => "other",
      });
      // Speak, go quiet, let the park fire.
      useDictationStore.getState().setSpeaking(false);
      vi.advanceTimersByTime(IDLE_RELAY_PARK_MS + 1_000);
      expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");

      // Alt-tab away and back. THE RELAY REOPENS — and `speaking` is ALREADY false, so no VAD edge
      // can ever fire again. Without a re-arm here the socket bills indefinitely while the user
      // reads, which is the very High the park exists to close (roborev 57795).
      ctrl.notifyWindowFocus(false);
      ctrl.notifyWindowFocus(true);
      invoke.mockClear();
      vi.advanceTimersByTime(IDLE_RELAY_PARK_MS + 1_000);
      expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");
      ctrl.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a park pending in a BACKGROUND window never closes the focused window's relay", async () => {
    vi.useFakeTimers();
    try {
      useDictationStore.setState({
        enabled: true,
        status: "listening",
        phase: "active",
        focusOwner: "other",
        speaking: true,
      });
      // This controller stands in for window A, which goes to the background.
      let focused = true;
      const ctrl = await createDictationController({
        onSegment: vi.fn(),
        isWindowActive: () => focused,
        focusOwner: () => "other",
      });
      // A blurs. Its teardown writes `speaking: false`, which is what used to ARM a timer inside a
      // window that no longer owns anything — `phase` is cross-window synced and RETAINED through a
      // blur, so that timer would later find its own phase still "active".
      ctrl.notifyWindowFocus(false);
      focused = false;
      invoke.mockClear();
      // Meanwhile window B opens a session on the single global relay. A's stale timer must not
      // reach out and close it.
      vi.advanceTimersByTime(IDLE_RELAY_PARK_MS * 3);
      expect(invoke).not.toHaveBeenCalledWith("stop_cloud_stream");
      ctrl.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a NON-ROUTABLE terminal teardown cancels the pending park in the same window", async () => {
    // The path my first decline got wrong (roborev 57802). A terminal teardown RETAINS
    // `phase: "active"`, so `tearDownOwnedStream`'s own early-return never fires here — and the
    // window stays focused, so the timer's `isWindowActive()` guard passes too. Both of the guards
    // I claimed covered this path are bypassed, and the teardown would run a second time.
    //
    // The terminal is made non-routable through `status: "error"` — `terminalRoutingArmed` is
    // false when the mic is faulted — which is what turns the caret landing there from a
    // DESTINATION into a teardown. (My first attempt at this test used a healthy mic, where a
    // terminal is a destination and no teardown happens at all.)
    vi.useFakeTimers();
    try {
      useDictationStore.setState({
        enabled: true,
        status: "listening",
        phase: "active",
        focusOwner: "other",
        speaking: true,
      });
      let owner: FocusOwner = "other";
      const ctrl = await createDictationController({
        onSegment: vi.fn(),
        isWindowActive: () => true,
        focusOwner: () => owner,
      });
      // Quiet — the park is now pending.
      useDictationStore.getState().setSpeaking(false);
      // The mic faults and the caret lands in a terminal: not a destination, so the relay closes.
      useDictationStore.setState({ status: "error" });
      owner = "terminal";
      invoke.mockClear();
      ctrl.notifyFocusOwner("terminal");
      const closes = () => invoke.mock.calls.filter((c) => c[0] === "stop_cloud_stream").length;
      expect(closes()).toBe(1);
      // The pending park must have gone with the relay — no SECOND close a minute later.
      vi.advanceTimersByTime(IDLE_RELAY_PARK_MS * 2);
      expect(closes()).toBe(1);
      ctrl.cleanup();
    } finally {
      vi.useRealTimers();
      useDictationStore.setState({ status: "idle" });
    }
  });

  it("a teardown while the user is MID-UTTERANCE does not arm a park behind itself", async () => {
    // THE SIBLING OF THE CASE ABOVE, and the one that catches an ordering bug it cannot
    // (roborev 57804). That case goes quiet BEFORE the teardown, so the `setSpeaking(false)` inside
    // `tearDownOwnedStream` is a value no-op and the subscriber's own edge guard filters it. Here
    // the room is still noisy at teardown, so that write is a real falling edge — and it used to
    // re-arm the park the teardown had just cancelled, five lines earlier.
    //
    // Reachable exactly as set up here: `dictation://error` writes `status: "error"` and never
    // clears `speaking`, so a mic that faults mid-word leaves `speaking: true`; the caret then
    // landing in a terminal that can no longer receive is a teardown with the room still noisy.
    vi.useFakeTimers();
    try {
      useDictationStore.setState({
        enabled: true,
        status: "listening",
        phase: "active",
        focusOwner: "other",
        speaking: true,
      });
      let owner: FocusOwner = "other";
      const ctrl = await createDictationController({
        onSegment: vi.fn(),
        isWindowActive: () => true,
        focusOwner: () => owner,
      });
      // NO `setSpeaking(false)` here — that is the whole difference from the case above.
      useDictationStore.setState({ status: "error" });
      owner = "terminal";
      invoke.mockClear();
      ctrl.notifyFocusOwner("terminal");
      const closes = () => invoke.mock.calls.filter((c) => c[0] === "stop_cloud_stream").length;
      expect(closes()).toBe(1);
      // A park armed by the teardown's own `setSpeaking(false)` would fire here and close again.
      vi.advanceTimersByTime(IDLE_RELAY_PARK_MS * 2);
      expect(closes()).toBe(1);
      ctrl.cleanup();
    } finally {
      vi.useRealTimers();
      useDictationStore.setState({ status: "idle", speaking: false });
    }
  });

  it("does not leave a park timer running after the controller is torn down", async () => {
    vi.useFakeTimers();
    try {
      useDictationStore.setState({
        enabled: true,
        status: "listening",
        phase: "active",
        focusOwner: "other",
        speaking: true,
      });
      const ctrl = await createDictationController({
        onSegment: vi.fn(),
        isWindowActive: () => true,
        focusOwner: () => "other",
      });
      useDictationStore.getState().setSpeaking(false);
      ctrl.cleanup();
      invoke.mockClear();
      // A timer that survived teardown would fire against a store the NEXT controller owns, parking
      // a relay this one never opened.
      vi.advanceTimersByTime(IDLE_RELAY_PARK_MS * 2);
      expect(invoke).not.toHaveBeenCalledWith("stop_cloud_stream");
    } finally {
      vi.useRealTimers();
    }
  });

  // ══ A BACKGROUND WINDOW MUST NOT TEAR DOWN THE FOCUSED WINDOW'S RELAY ══════════════════════
  // `phase` is persisted and CROSS-WINDOW SYNCED, so a wake in one window rehydrates every other
  // window's store and fires the phase edge there too. Routed through the full focus handler, a
  // background window whose caret sits in a terminal fell into the pause branch and called
  // `stop_cloud_stream` — one global backend resource — killing the relay the FOCUSED window had
  // just opened, and dictation silently fell back to on-device (roborev 56061).
  //
  // I deleted this case once, on the reasoning that the `isWindowActive()` guard I had added was
  // unfalsifiable. That conflated the GUARD with the BEHAVIOUR: the guard is indeed unfalsifiable
  // once the stream calls leave this path, but the behaviour is not — this fails under the pre-fix
  // code, where `tearDownOwnedStream` does not early-return because the synced phase is already
  // "active" (roborev 56064).
  it("does not tear down the relay from a window that is not focused", async () => {
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "passive",
      focusOwner: "terminal",
    });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => false, // this window is in the background
      focusOwner: () => "terminal",
    });
    invoke.mockClear();
    useDictationStore.getState().setPhase("active"); // the OTHER window's wake, synced into here
    expect(invoke).not.toHaveBeenCalledWith("stop_cloud_stream");
    ctrl.cleanup();
  });

  it("moving the caret into a terminal while dictation is FAULTED still tears the relay down", async () => {
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    // `phase: "active"` so `tearDownOwnedStream` does NOT early-return — this case owns the
    // active-phase side of the terminal branch, and the relay teardown is the part only it can see.
    // `status: "error"` is what makes this terminal a NON-destination while phase stays "active" —
    // and phase must stay "active" or `tearDownOwnedStream` early-returns and the relay assertion
    // below becomes unreachable. A faulted mic cannot type anywhere, so the old pause still applies.
    useDictationStore.setState({
      interim: "half a sentence",
      level: 0.8,
      speaking: true,
      onDeviceSpeech: true,
      phase: "active",
      status: "error",
      enabled: true,
      focusOwner: "other", // see the sibling test: the subscription needs a real transition
    });
    invoke.mockClear();
    // The app-root tracker writes this; the controller subscribes to it.
    useDictationStore.getState().setFocusOwner("terminal");
    // ══ THE BILLABLE RELAY IS TORN DOWN, and this is the only test that can prove it ═════════════
    // The terminal branch DELEGATES that to `tearDownOwnedStream()`; everything else it does it does
    // itself. So without this assertion, deleting the `tearDownOwnedStream()` CALL leaves the whole
    // suite green while a Deepgram relay keeps streaming — and METERING — after the user clicks into
    // a terminal. That is the sparkle-ozvr class of bug, in the one place the pause was added to
    // prevent it. Asserted here rather than in the passive-phase case below, which cannot reach it:
    // tearDownOwnedStream early-returns on any phase but "active".
    expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");
    const s = useDictationStore.getState();
    // …and the latch is cleared on this path too, not only on the passive one.
    expect(s.onDeviceSpeech).toBe(false);
    expect(s.interim).toBe("");
    expect(s.level).toBe(0);
    expect(s.speaking).toBe(false);
    // The fault is NOT painted over: "idle" would drop the cause, and the error surface is the one
    // presentation that states it.
    expect(s.status).toBe("error");
    // NEITHER of these may move: the mic stays armed, and an active "Hey Sparkle" session must
    // survive clicking into a terminal and back without re-saying the wake word.
    expect(s.enabled).toBe(true);
    expect(s.phase).toBe("active");
    ctrl.cleanup();
  });
});

describe("the on-device speech LEVEL — the countdown's cancel, and the latch that must not stick", () => {
  // `dictation://on-device-speech` is what lets resumed speech stop an auto-send countdown on the
  // path with no interim results. Everything about it is dangerous in one direction: while it reads
  // true, `useAutoSend` refuses to start a clock at all — so a value that gets STUCK true does not
  // merely mis-cancel, it disables auto-send for the rest of the session.
  beforeEach(() => {
    // `focusOwner` is reset explicitly: an earlier block leaves it on "terminal", and the caret
    // test below drives a store CHANGE — setting it to a value it already holds notifies nobody.
    useDictationStore.setState({
      onDeviceSpeech: false,
      focusOwner: "other",
      windowFocused: true,
      enabled: true,
      status: "listening",
      phase: "active",
      interim: "",
      speaking: false,
      level: 0,
    });
  });

  it("the listener carries the payload into the store", async () => {
    // Driven through the REAL listener rather than the store setter, which is the gap that let the
    // whole `listen(...)` block be deletable with the suite still green.
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    emit("dictation://on-device-speech", true);
    expect(useDictationStore.getState().onDeviceSpeech).toBe(true);
    emit("dictation://on-device-speech", false);
    expect(useDictationStore.getState().onDeviceSpeech).toBe(false);
    ctrl.cleanup();
  });

  it("a window dictation may not route into FORCES it false, even on a true payload", async () => {
    // Not merely "ignores": a latched true would suspend the next countdown that legitimately
    // starts, so the non-routable branch has to clear rather than skip.
    useDictationStore.setState({ onDeviceSpeech: true });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    emit("dictation://on-device-speech", true);
    expect(useDictationStore.getState().onDeviceSpeech).toBe(false);
    ctrl.cleanup();
  });

  it("THE LATCH: losing window focus mid-utterance clears it", async () => {
    // Rust's edge state is PER-CAPTURE and starts false, so a capture torn down while this is true
    // emits no falling edge, and a rebuilt capture computing false sees no change and emits nothing
    // either — nothing would ever resync it. Left set, `useAutoSend` reads "still talking" forever:
    // startClock early-returns on every speech-end and auto-send never fires again for the session.
    // That is the "suspend every cloud countdown forever" failure reached through a different door.
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    emit("dictation://on-device-speech", true);
    expect(useDictationStore.getState().onDeviceSpeech).toBe(true);
    emit("dictation://focus", false); // tabbed away mid-utterance
    expect(useDictationStore.getState().onDeviceSpeech).toBe(false);
    ctrl.cleanup();
  });

  it("THE LATCH: the caret moving into a terminal clears it too", async () => {
    // `phase: "passive"` ON PURPOSE, and it is what makes this case pin its OWN line. The terminal
    // branch calls `tearDownOwnedStream()` first, but that early-returns unless the phase is
    // "active" — so on a passive phase the branch's own clear is the ONLY one that runs. With
    // "active" both fire and either alone satisfies the assertion, which is how this line sat
    // unpinned while the suite looked green. The window-handoff case above covers the "active" side.
    // Seeded DIRTY on purpose (roborev 55415). With the teardown short-circuited, the branch's own
    // three writes are the only thing that can flatten these — and a passive window really does
    // accumulate them, because the partial/level/speaking listeners gate on `isRoutable()`, not on
    // phase. Seeding them already-flat (as the shared beforeEach does) made the assertions unable to
    // tell "flattened" from "never dirty", so deleting those three lines left the suite green while a
    // window the user clicked out of kept rendering stale interim text and an animating waveform.
    useDictationStore.setState({
      phase: "passive",
      interim: "half a sentence",
      level: 0.8,
      speaking: true,
    });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    emit("dictation://on-device-speech", true);
    expect(useDictationStore.getState().onDeviceSpeech).toBe(true);
    useDictationStore.getState().setFocusOwner("terminal");
    const s = useDictationStore.getState();
    expect(s.onDeviceSpeech).toBe(false);
    // The branch's OWN flatten, each one pinned individually.
    expect(s.interim).toBe("");
    expect(s.level).toBe(0);
    expect(s.speaking).toBe(false);
    ctrl.cleanup();
  });

  it("THE LATCH: a window-to-window handoff clears it — the one path with no `dictation://focus`", async () => {
    // PINS `tearDownOwnedStream`'s clear ON ITS OWN. Every other case reaches a SECOND, redundant
    // clear further down its path (notifyFocusOwner clears again after calling this), so deleting
    // this one alone left the whole suite green — the latch could be reintroduced by a cleanup that
    // reads the second write as the redundant one. `notifyWindowFocus(false)` is the per-window OS
    // blur, which is exactly the handoff `dictation://focus` never fires for (it stays true while
    // ANY Sparkle window is up), so this is the only clear that runs on it.
    //
    // `phase: "active"` matters: tearDownOwnedStream early-returns on any other phase, so without
    // it this test would pass without executing the line it exists to pin.
    useDictationStore.setState({ phase: "active" });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    emit("dictation://on-device-speech", true);
    expect(useDictationStore.getState().onDeviceSpeech).toBe(true);
    ctrl.notifyWindowFocus(false);
    expect(useDictationStore.getState().onDeviceSpeech).toBe(false);
    ctrl.cleanup();
  });

  // KNOWN GAP, stated rather than left to be discovered: the SIXTH clear lives in
  // `useAmbientVoice`'s own `enabled === false` effect, which is a React hook and not reachable from
  // this file — these cases drive `createDictationController` directly. Deleting that one alone
  // leaves this suite green. It is needed (muting stops capture, and a re-arm starts a fresh Rust
  // edge state that emits nothing if it computes false), so if it is ever refactored, re-verify it
  // by hand or move the mute reset into the controller where it can be pinned.
  it("THE LATCH: muting the mic clears it", async () => {
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    emit("dictation://on-device-speech", true);
    // Asserted BEFORE the toggle, like the two cases above: without it, a listener gate that stops
    // delivering would leave the store already false and this test would pass over a clear that
    // never ran — pinning nothing.
    expect(useDictationStore.getState().onDeviceSpeech).toBe(true);
    await ctrl.toggle(); // status was "listening", so this stops dictation
    expect(useDictationStore.getState().onDeviceSpeech).toBe(false);
    ctrl.cleanup();
  });
});

// ══ THE PUSH-TO-TALK TAIL: `interim` AT cloud-ended IS THE USER'S LAST WORDS ═══════════════════
// The founder dictates nearly everything he sends and his final words kept getting cut off. The
// cause was in this file: `dictation://cloud-ended` cleared `interim` UNCONDITIONALLY. That is a
// no-op on a clean close (Rust's Finalize + read-drain already delivered the trailing final as a
// `dictation://partial`, so `interim` is already ""), but the same event fires on a mid-stream relay
// failure and on the out-of-credits teardown — where no final is coming and `interim` still holds
// words the user actually said. They were dropped silently.
//
// EVERY ROW ASSERTS THE SIDE EFFECT — a segment DELIVERED, a seq BUMPED, the sink CALLED — never
// that `interim` became "", which was already true before the fix and would prove nothing.
describe("the orphaned interim tail at cloud-ended (the truncation bug)", () => {
  beforeEach(() => {
    useDictationStore.setState({
      interim: "",
      status: "listening",
      enabled: true,
      phase: "active",
      error: null,
      windowFocused: true,
      focusOwner: "other",
      insertTarget: null,
    });
    routeToTerminal.mockClear();
    // The engine store is module state shared across this file's rows (and it is the one thing the
    // `cloud-ended` handler now writes on EVERY path), so reset it here rather than letting one
    // row's fallback reason decide another's starting point.
    useDictationEngineStore.setState({ fallbackReason: null, dismissed: false });
  });

  it("COMMITS a non-empty interim as a segment instead of dropping it", async () => {
    const onSegment = vi.fn();
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    useDictationStore.setState({ interim: "and one more thing before I forget" });
    // A mid-stream relay death: no trailing final will arrive, so this text is all there is.
    emit("dictation://cloud-ended", false);
    // THE ASSERTION THAT FAILS AGAINST THE OLD CODE: the words reach a destination. Before the fix
    // `onSegment` was never called on this path and the tail was gone with no trace anywhere.
    expect(onSegment).toHaveBeenCalledWith("and one more thing before I forget", {
      terminal: false,
    });
    ctrl.cleanup();
  });

  it("bumps committedSeq for the recovered tail, so the push-to-talk drain sees it land", async () => {
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    const before = useDictationStore.getState().committedSeq;
    useDictationStore.setState({ interim: "the tail" });
    emit("dictation://cloud-ended", false);
    // `useSendMode`'s release drain settles on "has anything landed since the release" and reads
    // ONLY this counter (roborev 57295). A tail delivered without bumping it can still be raced by
    // the drain and sent-past — recovering the words but not in time for the message they belong to.
    expect(useDictationStore.getState().committedSeq).toBe(before + 1);
    ctrl.cleanup();
  });

  it("commits NOTHING when the interim is empty — the clean-close path stays a no-op", async () => {
    const onSegment = vi.fn();
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    const before = useDictationStore.getState().committedSeq;
    emit("dictation://cloud-ended", false);
    // The overreach guard. On a clean close the trailing final ALREADY arrived as a partial and
    // cleared `interim`; a recovery that fired regardless would deliver an empty segment and bump
    // the drain's counter for text nobody said.
    expect(onSegment).not.toHaveBeenCalled();
    expect(useDictationStore.getState().committedSeq).toBe(before);
    ctrl.cleanup();
  });

  it("commits nothing for a whitespace-only interim", async () => {
    const onSegment = vi.fn();
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    useDictationStore.setState({ interim: "   \n " });
    emit("dictation://cloud-ended", false);
    expect(onSegment).not.toHaveBeenCalled();
    ctrl.cleanup();
  });

  it("recovers the tail on the OUT-OF-CREDITS teardown too, and still refreshes the balance", async () => {
    // The exhausted path is the one where a user is MOST likely to be mid-sentence: the relay cuts
    // them off, so the tail is guaranteed to be uncommitted. Both effects must happen — an earlier
    // shape could plausibly early-return on `exhausted` and skip one of them.
    const refresh = vi.spyOn(useAuthStore.getState(), "refresh").mockResolvedValue();
    const onSegment = vi.fn();
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    useDictationStore.setState({ interim: "cut off mid sen" });
    emit("dictation://cloud-ended", true);
    expect(onSegment).toHaveBeenCalledWith("cut off mid sen", { terminal: false });
    expect(refresh).toHaveBeenCalledTimes(1);
    refresh.mockRestore();
    ctrl.cleanup();
  });

  it("sends the tail to the TERMINAL, not the composer, when the caret is in a routable terminal", async () => {
    // THE DESTINATION IS NOT ASSUMED. `{ terminal: true }` names WHERE the text goes — hand it back
    // to be typed into the PTY the user is driving — and a recovery that skipped this gate would
    // insert the tail into a composer the user is not looking at while their terminal sat empty.
    const onSegment = phaseMachine();
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    useDictationStore.setState({ interim: "npm run buil" });
    emit("dictation://cloud-ended", false);
    expect(onSegment).toHaveBeenCalledWith("npm run buil", { terminal: true });
    // …and it travelled the whole way, through the same sink every committed segment uses.
    expect(routeToTerminal).toHaveBeenCalledWith("npm run buil");
    ctrl.cleanup();
  });

  it("a terminal REFUSAL leaves the tail in the composer rather than dropping it", async () => {
    // The refusal fallback is part of the committed-segment contract, and the tail inherits it by
    // going through the same delivery function — not by a second copy of the logic that could omit
    // it. A tail typed at a live picker would otherwise vanish twice over.
    routeToTerminal.mockResolvedValueOnce({
      kind: "refused",
      agentId: "a1",
      reason: "awaiting-input",
    });
    // Through `insertTarget` — the REAL mechanism — not a hand-installed `insert` action: `insert`
    // is a silent no-op when no compose box registered a target (roborev 56057).
    const insert = vi.fn();
    useDictationStore.setState({ insertTarget: insert });
    const ctrl = await createDictationController({
      onSegment: phaseMachine(),
      isWindowActive: () => true,
      focusOwner: () => "terminal",
    });
    useDictationStore.setState({ interim: "the words" });
    emit("dictation://cloud-ended", false);
    // The delivery is awaited inside the listener's promise chain, so let it settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(insert).toHaveBeenCalledWith("the words");
    useDictationStore.setState({ insertTarget: null });
    ctrl.cleanup();
  });

  it("a BACKGROUND window commits nothing — the tail belongs to the window that heard it", async () => {
    // The recovery rides the SAME one gate as every other committed segment. Without that, one relay
    // failure would type the tail into every open window's composer at once (sparkle-ozvr), which is
    // the bug the gate exists to prevent — reached by a new door.
    const onSegment = vi.fn();
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => false,
      focusOwner: () => "other",
    });
    useDictationStore.setState({ interim: "not this window's words" });
    emit("dictation://cloud-ended", false);
    expect(onSegment).not.toHaveBeenCalled();
    // The preview is still cleared, so no ghost is left painted in the background window.
    expect(useDictationStore.getState().interim).toBe("");
    ctrl.cleanup();
  });

  it("never repeats a tail: a committed partial clears interim, so the next cloud-ended has nothing", async () => {
    // THE NO-DUPLICATION INVARIANT, exercised rather than asserted in prose. The partial handler
    // clears `interim` on every committed segment, so a non-empty `interim` at cloud-ended is by
    // construction text no segment has carried. This drives the ordinary clean-close sequence —
    // final arrives, then the stream ends — and pins that it yields exactly ONE delivery.
    const onSegment = vi.fn();
    const ctrl = await createDictationController({
      onSegment,
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    useDictationStore.setState({ interim: "hello wor" });
    emit("dictation://partial", "hello world");
    emit("dictation://cloud-ended", false);
    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment).toHaveBeenCalledWith("hello world", { terminal: false });
    ctrl.cleanup();
  });

  it("tells the engine store the cloud is gone, naming out-of-credits distinctly", async () => {
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    emit("dictation://cloud-ended", false);
    // Dictation keeps working on-device — with NO interim results at all, so the live word-by-word
    // preview structurally stops existing. A silent engine swap reads as a broken feature.
    expect(useDictationEngineStore.getState().fallbackReason).toBe("unavailable");
    emit("dictation://cloud-ended", true);
    // Out-of-credits is the one cause the user can act on, so it must not collapse into "unavailable".
    expect(useDictationEngineStore.getState().fallbackReason).toBe("exhausted");
    ctrl.cleanup();
  });
});
