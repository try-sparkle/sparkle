// @vitest-environment jsdom
/**
 * THE ENGINE-FALLBACK SIGNAL, ON THE PATH THAT ACTUALLY OPENS THE RELAY.
 *
 * `start_cloud_stream` returns a `CloudStreamOutcome` naming what the relay decided:
 * `opened`/`resumed`/`already_routing` = the cloud is live; `raced` = a stop interleaved and says
 * nothing; the rest name a specific refusal (signed out, 401, 403, 402, 503, unreachable) and
 * dictation silently continues on-device. On-device is an OFFLINE transducer with no interim results at all,
 * so the live word-by-word preview structurally stops existing — a swap the user reads as a broken
 * feature unless something says so (see stores/dictationEngineStore).
 *
 * ITS OWN FILE, IN JSDOM, FOR THE SAME REASON `useDictation.arm.test.tsx` IS: the invoke lives in
 * `useAmbientVoice`'s `openCloud` ref, which is a React hook and unreachable from the node-env
 * controller tests. Those drive `createDictationController` directly and never construct the
 * `startCloudStream` closure at all — so the wiring could be deleted outright and every one of them
 * would stay green.
 *
 * The AI gate is mocked because it is not what is under test here: without it `aiFeatureNow` is
 * false for an unauthenticated fixture and `openCloud` early-returns before any invoke, so the test
 * would pass while proving nothing about the relay's answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const listeners: Record<string, Array<(e: { payload: unknown }) => void>> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(cb);
    return Promise.resolve(() => {
      listeners[name] = (listeners[name] ?? []).filter((c) => c !== cb);
    });
  },
}));

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

vi.mock("./services/dictationTerminalSink", () => ({
  routeDictationToTerminal: vi.fn().mockResolvedValue({ kind: "delivered", agentId: "a1", text: "x" }),
}));

// Both AI gates ON, so the cloud open is reached. `useAiFeature` is the hook form the component
// body calls; `aiFeatureNow` is the imperative one `openCloud` reads live.
vi.mock("./services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => true,
}));

import { useDictationStore } from "./stores/dictationStore";
import {
  noteCloudLate,
  useDictationEngineStore,
  type CloudStreamOutcome,
} from "./stores/dictationEngineStore";
import { useAmbientVoice } from "./useDictation";

/** Yield a real MACROTASK, not a microtask. `createDictationController` awaits a `Promise.all` over
 *  ~10 `listen()` calls before it subscribes to the store, and each mocked `listen` resolves on its
 *  own tick — so a fixed handful of `await Promise.resolve()` does NOT reliably get past them. A
 *  phase change driven too early outruns the subscriber, no edge fires, and the test fails asserting
 *  that `start_cloud_stream` was never invoked (which is what it did before this was a macrotask). */
const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

/** Mount the hook and let the controller finish attaching its listeners AND its store subscriber. */
async function mountVoice(): Promise<void> {
  renderHook(() => useAmbientVoice());
  await flush();
}

/** Drive the passive→active phase edge — the ONE opener of the billable relay — and let the async
 *  open settle. */
async function goActive(): Promise<void> {
  await act(async () => {
    useDictationStore.setState({ phase: "active" });
  });
  await flush();
}

/** Drop back to passive, so a following `goActive()` is a real EDGE. The passive→active subscriber
 *  fires on the transition, so two `goActive()` calls in a row open the relay only once — which
 *  would silently make a "two consecutive refusals" case a one-refusal case. */
async function goPassive(): Promise<void> {
  await act(async () => {
    useDictationStore.setState({ phase: "passive" });
  });
  await flush();
}

/** Focus a real composer textarea. TWO separate things depend on this, and missing either one makes
 *  the relay never open — which presents as the confusing "only `start_dictation` was invoked":
 *    1. `isWindowActive()` defaults to `document.hasFocus()`, and **jsdom reports `false` until
 *       something in the document is actually focused** (measured). `isCapturable()` fails on that
 *       alone, so the passive→active subscriber skips the cloud open entirely.
 *    2. `focusOwnerNow()` reads the LIVE DOM (not the store's `focusOwner` mirror, which exists for
 *       the copy), so a real focused element is what makes `focusPauseReason()` null.
 *  Mirrors `focusTheComposer` in useDictation.arm.test.tsx. */
function focusTheComposer(): void {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  ta.focus();
}

beforeEach(() => {
  document.body.innerHTML = "";
  focusTheComposer();
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  for (const k of Object.keys(listeners)) delete listeners[k];
  // Armed, routable, and PASSIVE — so the phase write below is a real edge.
  useDictationStore.setState({
    enabled: true,
    status: "listening",
    error: null,
    phase: "passive",
    interim: "",
    windowFocused: true,
    focusOwner: "other",
  });
  // `openRefusals` BELONGS IN THIS RESET (roborev 59941). Corroboration state is what decides
  // whether a refusal speaks, so leaving it out let the counter leak between cases and made this
  // file order-dependent — the refusal case below passed only because an earlier case had already
  // put the counter at 1. A green that depends on execution order is not coverage.
  useDictationEngineStore.setState({
    fallbackReason: null,
    dismissed: false,
    observedAt: null,
    openRefusals: 0,
  });
});

describe("the window-blur guard — a broadcast stand-down must not close the global relay", () => {
  // NOTHING covered this direction. useDictation.test.ts runs in the node env, where `hasWindow` is
  // false so the listener is never attached, and every window-focus case there drives
  // `notifyWindowFocus` directly — bypassing the guard entirely. So deleting the guard, or inverting
  // it, kept the whole suite green while silently disabling the per-window ownership handoff the
  // listener exists for (sparkle-ozvr / roborev 59711).
  //
  // Both cases mount with the window FOCUSED, because the guard is an EDGE: the controller seeds
  // `domWindowFocused` from `isWindowActive()` at creation, so a window that was already background
  // at mount has no true → false transition to make and would pass the first assertion vacuously.
  let hasFocus: ReturnType<typeof vi.spyOn> | null = null;
  afterEach(() => {
    // Restored here rather than at the end of each case: a case that fails before its own restore
    // would otherwise leak `hasFocus === false` into every later test in this file, where it blocks
    // the routing gate and turns unrelated relay assertions red. That is exactly what happened.
    hasFocus?.mockRestore();
    hasFocus = null;
  });

  const mountFocusedAndGoActive = async () => {
    hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream" ? Promise.resolve("opened") : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    // PRECONDITION, ASSERTED. `tearDownOwnedStream` early-returns unless phase is "active", so if
    // this were not true both cases below would pass without the guard doing anything at all.
    expect(useDictationStore.getState().phase).toBe("active");
    invoke.mockClear();
  };

  it("IGNORES a blur the DOM contradicts — the hatch's synthetic stand-down pulse", async () => {
    await mountFocusedAndGoActive();

    // The window is STILL focused; only the event claims otherwise.
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(invoke).not.toHaveBeenCalledWith("stop_cloud_stream");
  });

  it("still tears down on a REAL blur — the direction that must keep working", async () => {
    // The other half, and what makes the case above non-vacuous: a guard that suppressed EVERY blur
    // would also pass that assertion while breaking the window-to-window handoff that closes the
    // billable relay.
    await mountFocusedAndGoActive();

    hasFocus!.mockReturnValue(false); // the window really did go background
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");
  });
});

describe("the relay's own answer to start_cloud_stream drives the engine signal", () => {
  // THIS FILE IS THE ONLY PLACE THE `startCloudStream` CLOSURE IS ACTUALLY CONSTRUCTED (see the
  // header), so the corroboration contract has to be pinned HERE or it is pinned nowhere on the
  // wiring path — the node-env suites drive the store directly and would stay green if the closure
  // called the wrong action entirely.

  it("ONE unreachable relay stays silent — a blip is not yet an outage", async () => {
    // The remaining ambiguous case, and the only one that still needs corroboration: `unreachable`
    // means no answer arrived at all, which a transient network blip produces just as readily as a
    // real outage. (The case this test used to cover — a healthy already-routing socket counted as
    // a refusal — is gone: that now arrives as its own outcome and counts for nothing.)
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream"
        ? Promise.resolve("unreachable")
        : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    expect(invoke).toHaveBeenCalledWith("start_cloud_stream", expect.anything());
    expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
    // …and it was COUNTED, not ignored — otherwise a real outage could never accumulate a verdict.
    expect(useDictationEngineStore.getState().openRefusals).toBe(1);
  });

  it("a SECOND consecutive unreachable records the fallback — dictation is on-device now", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream"
        ? Promise.resolve("unreachable")
        : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    // A second passive→active edge, i.e. the user dictating again and being refused again.
    await goPassive();
    await goActive();
    // The invoke really happened — otherwise the assertion below would be reading an untouched
    // store and would pass for a fixture that never opened anything.
    expect(invoke).toHaveBeenCalledWith("start_cloud_stream", expect.anything());
    // THE ASSERTION. Before the wiring, the boolean was consumed by openCloudDictationWindow and
    // thrown away: a refusal was indistinguishable from a live stream anywhere in the UI.
    expect(useDictationEngineStore.getState().fallbackReason).toBe("unavailable");
  });

  it("a SUCCESS (true) records nothing — the resting state is 'no problem known'", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream" ? Promise.resolve("opened") : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    expect(invoke).toHaveBeenCalledWith("start_cloud_stream", expect.anything());
    // The overreach guard: a signal that fired on every open would light the banner permanently
    // while nothing was wrong, which is worse than not having it.
    expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
  });

  // ── THE LATE-RELAY CASE, DRIVEN THROUGH THE REAL CLOSURE ──────────────────────────────────────
  // `dictationEngineStore.test.ts` pins the latch and the classifier, but it composes them the way
  // the production code is SUPPOSED to and never touches `startCloudStream` — so reverting that one
  // `else if` line left all of it green (stated as a known gap when the wiring landed; roborev
  // 59692). These two drive the actual closure, and they are the only assertions in the tree that go
  // red if the call site stops reading the latch.
  //
  // BOTH ORDERINGS, because the event and the invoke's response race and Tauri orders neither. The
  // first version of this wiring worked in exactly one of them and the working order hid the other.

  /** Deliver `dictation://cloud-late` — Rust's "we DID connect, then discarded it for landing after
   *  the utterance". Emitted only for the CURRENT generation (see `late_report_for`). */
  const fireCloudLate = () => {
    for (const cb of listeners["dictation://cloud-late"] ?? []) cb({ payload: undefined });
  };

  it("reports too-slow when the event lands BEFORE start_cloud_stream resolves", async () => {
    // The open is held pending so the event provably wins the race, rather than the test hoping it
    // does. This is the ordering where the store write comes from `startCloudStream` reading the
    // latch — delete the `else if` and this goes to `null` + one refusal.
    let release!: (outcome: CloudStreamOutcome) => void;
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream"
        ? new Promise<CloudStreamOutcome>((r) => {
            release = r;
          })
        : Promise.resolve(undefined),
    );
    await mountVoice();
    await act(async () => {
      useDictationStore.setState({ phase: "active" });
    });
    await flush();
    expect(invoke).toHaveBeenCalledWith("start_cloud_stream", expect.anything());

    fireCloudLate(); // the relay connected — the socket just arrived too late to be installed
    await act(async () => {
      // BOTH raced arms answer `raced`, which classifies as `ignore`: right about billing and about
      // the counter, and silent about why the preview never appeared. The event carries that.
      release("raced");
    });
    await flush();

    expect(useDictationEngineStore.getState().fallbackReason).toBe("too-slow");
    // AND IT DID NOT SPEND A CORROBORATION ROUND. `noteCloudOpenRefused` exists for the ambiguous
    // `false` (AlreadyRouting); a proven late handshake is not ambiguous, so routing it through the
    // counter would delay the honest copy by an utterance and let a stale count speak later.
    expect(useDictationEngineStore.getState().openRefusals).toBe(0);
  });

  it("corrects to too-slow when the event lands AFTER the invoke already resolved", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream" ? Promise.resolve("raced") : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    // `raced` is classified `ignore`, so the invoke half said NOTHING — no banner and no charge.
    // Asserting that here is what makes the correction below meaningful rather than a re-assertion
    // of something already true.
    expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
    expect(useDictationEngineStore.getState().openRefusals).toBe(0);

    fireCloudLate();
    await flush();

    expect(useDictationEngineStore.getState().fallbackReason).toBe("too-slow");
  });

  it("a LIVE outcome still retires the banner even when a late latch is set", async () => {
    // THE ONLY ASSERTION IN THE TREE THAT REDS IF THE CONTINUATION IS REORDERED BACK TO LATCH-FIRST
    // (roborev 60394, kept by 60441). The successor of a parked stream typically answers `resumed`,
    // and the late latch can still be set when it resolves. Latch-first reported `too-slow` over a
    // socket that is live right now and — worse — skipped `noteCloudLive`, leaving a standing banner
    // up and the corroboration counter armed.
    //
    // The LATCH is set directly rather than by firing the event, deliberately: the `cloud-late`
    // LISTENER writes the store itself (that is the event-lands-second ordering it exists for), so
    // firing it here would assert the listener's write, not the closure's precedence — which is the
    // thing this test is about. Its neighbours fire the event for that other path.
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream"
        ? Promise.resolve("unreachable")
        : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    await goPassive();
    await goActive(); // two unreachables — the banner is up and the count is armed
    expect(useDictationEngineStore.getState().fallbackReason).toBe("unavailable");

    // Hold the next attempt open so the latch is provably set while it is in flight.
    let resolveIt!: (o: CloudStreamOutcome) => void;
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream"
        ? new Promise<CloudStreamOutcome>((r) => {
            resolveIt = r;
          })
        : Promise.resolve(undefined),
    );
    await goPassive();
    await act(async () => {
      useDictationStore.setState({ phase: "active" });
    });
    await flush();
    noteCloudLate(); // the park arm's event, latched but not yet spoken for
    await act(async () => {
      resolveIt("resumed"); // …and this attempt resumed that very socket
    });
    await flush();

    expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
    expect(useDictationEngineStore.getState().openRefusals).toBe(0);
  });

  it("a NAMED refusal still speaks even when a late latch is set", async () => {
    // THE OTHER HALF OF THE SAME PREDICATE (roborev 60444). Its sibling above pins `live`; this pins
    // `definitive`, and without it dropping `|| verdict.kind === "definitive"` from the condition
    // leaves the whole suite green — the three named-refusal tests never set the late latch, so they
    // fall through to the identical `else engine.noteCloudOutcome(outcome)` on both orderings.
    //
    // The user-visible loss is the same one, one verdict class over: under latch-first,
    // `noteCloudConnectedLate(true)` runs while `fallbackReason` is still null, so nothing is
    // preserved and a user at zero credits reads "connected too late for that utterance" instead of
    // "You're out of Sparkle credits… Refill" — copy naming no remedy they can act on.
    let resolveIt!: (o: CloudStreamOutcome) => void;
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream"
        ? new Promise<CloudStreamOutcome>((r) => {
            resolveIt = r;
          })
        : Promise.resolve(undefined),
    );
    await mountVoice();
    await act(async () => {
      useDictationStore.setState({ phase: "active" });
    });
    await flush();
    noteCloudLate(); // a park-arm event, latched while this attempt is still in flight
    await act(async () => {
      resolveIt("insufficient_credits"); // …and the relay named the cause for THIS attempt
    });
    await flush();

    expect(useDictationEngineStore.getState().fallbackReason).toBe("exhausted");
  });

  /** Deliver `dictation://cloud-orphan` — a handshake for a generation that has since rotated.
   *  NOTHING LISTENS TO IT ANY MORE, and these cases exist to keep it that way (roborev
   *  60408/60429): two mechanisms were built on this event (an orphan latch, and a charged-refusal
   *  withdrawal) and both were deleted, because an orphan's own attempt answers `raced` — already
   *  "record nothing" — so either could only ever reach a DIFFERENT attempt's state, in this window
   *  or, since it is an `app.emit`, in another one. */
  const fireCloudOrphan = () => {
    for (const cb of listeners["dictation://cloud-orphan"] ?? []) cb({ payload: undefined });
  };

  it("an ORPHANED handshake records nothing at all — not a banner, and not a refusal", async () => {
    // The originating attempt answers `raced`, which classifies `ignore`. Three re-holds is one more
    // than OPEN_REFUSALS_BEFORE_WARNING, so a counted orphan would have spoken by now.
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream" ? Promise.resolve("raced") : Promise.resolve(undefined),
    );
    await mountVoice();

    for (let hold = 0; hold < 3; hold += 1) {
      await goPassive();
      await goActive();
      fireCloudOrphan();
      await flush();
    }

    expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
    expect(useDictationEngineStore.getState().openRefusals).toBe(0);
  });

  it("an orphan mid-flight does NOT swallow a genuine unreachable", async () => {
    // THE LOAD-BEARING ORDERING, and the one every earlier orphan test missed (roborev 60429). The
    // event is held against an attempt that is genuinely in flight and then answers `unreachable` —
    // real evidence about the relay, from a different attempt than the orphan's. The deleted latch
    // swallowed exactly this: the counter never incremented and the user was told nothing. Feeding
    // `raced`, or firing the orphan after the attempt resolved, cannot see it — which is why those
    // shapes stayed green while the latch existed.
    let release!: (o: CloudStreamOutcome) => void;
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream"
        ? new Promise<CloudStreamOutcome>((r) => {
            release = r;
          })
        : Promise.resolve(undefined),
    );
    await mountVoice();
    await act(async () => {
      useDictationStore.setState({ phase: "active" });
    });
    await flush();

    fireCloudOrphan(); // an orphan from a PREVIOUS generation lands mid-flight
    await act(async () => {
      release("unreachable");
    });
    await flush();

    expect(useDictationEngineStore.getState().openRefusals).toBe(1);
  });

  it("a broadcast orphan cannot touch another window's standing banner", async () => {
    // `dictation://cloud-orphan` is an `app.emit`, so every window runs whatever is listening. This
    // window genuinely earned its banner; an orphan fired by an attempt in a DIFFERENT window must
    // leave both the banner and the count exactly where they are.
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream"
        ? Promise.resolve("unreachable")
        : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    await goPassive();
    await goActive();
    expect(useDictationEngineStore.getState().openRefusals).toBe(2);
    expect(useDictationEngineStore.getState().fallbackReason).toBe("unavailable");

    fireCloudOrphan();
    await flush();

    expect(useDictationEngineStore.getState().openRefusals).toBe(2);
    expect(useDictationEngineStore.getState().fallbackReason).toBe("unavailable");
  });

  it("a late connect resets the corroboration, so refuse → late → refuse never reaches the threshold", async () => {
    // THE FLAP THIS WHOLE SEAM EXISTS TO REMOVE, straddling a PROVEN-LIVE connection (roborev
    // 60355). Without the reset the third attempt is the second consecutive refusal, so the bar
    // claims Sparkle "can't reach the cloud transcription service" over a relay that connected one
    // utterance earlier — and silently downgrades the honest `too-slow` while doing it.
    let outcome: CloudStreamOutcome = "unreachable";
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream" ? Promise.resolve(outcome) : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive(); // refusal #1
    expect(useDictationEngineStore.getState().openRefusals).toBe(1);

    outcome = "raced"; // …but this one connected, just too late
    await goPassive();
    await goActive();
    fireCloudLate();
    await flush();
    expect(useDictationEngineStore.getState().openRefusals).toBe(0);

    outcome = "unreachable";
    await goPassive();
    await goActive(); // refusal, and it must be counted as the FIRST of a new run
    expect(useDictationEngineStore.getState().openRefusals).toBe(1);
    expect(useDictationEngineStore.getState().fallbackReason).toBe("too-slow");
  });

  // THE FOUNDER'S SYMPTOM, PINNED ON THE WIRING PATH. `already_routing` is what the command answers
  // on a repeated passive→active edge onto a healthy socket — the most common outcome in ordinary
  // use. It used to arrive as the same `false` as a refusal and was COUNTED as one, which is what
  // made the banner pop up and go away while the relay was fine. It must now count for nothing.
  it("an ALREADY-ROUTING socket is not a refusal — it does not even accumulate", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream"
        ? Promise.resolve("already_routing")
        : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    await goPassive();
    await goActive();
    expect(invoke).toHaveBeenCalledWith("start_cloud_stream", expect.anything());
    expect(useDictationEngineStore.getState().openRefusals).toBe(0);
    expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
  });

  // The other half of the fix: when the relay DOES name a cause, the wiring reports it at once and
  // by name. One attempt, no corroboration — and not the generic "unavailable".
  it("a NAMED refusal reports immediately, with the specific reason", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream"
        ? Promise.resolve("insufficient_credits")
        : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    expect(invoke).toHaveBeenCalledWith("start_cloud_stream", expect.anything());
    expect(useDictationEngineStore.getState().fallbackReason).toBe("exhausted");
  });

  it("a rejected session is named as a sign-in problem, not a network one", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream"
        ? Promise.resolve("unauthorized")
        : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    expect(useDictationEngineStore.getState().fallbackReason).toBe("signed_out");
  });

  it("a cloud stream coming back RETIRES a standing fallback and re-arms the dismissal", async () => {
    // The recovery half. Without it the banner outlives the outage it describes — the user fixes
    // their connection, dictation goes back to streaming interims, and the app still says it isn't.
    useDictationEngineStore.setState({ fallbackReason: "exhausted", dismissed: true });
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream" ? Promise.resolve("opened") : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
    expect(useDictationEngineStore.getState().dismissed).toBe(false);
  });
});
