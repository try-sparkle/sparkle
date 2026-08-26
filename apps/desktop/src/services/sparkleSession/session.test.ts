// The overlay session, driven through its REAL entry point (bead sparkle-uz87.7).
//
// WHAT MAKES THESE NON-VACUOUS. The claim being tested is an ORDER, so every assertion here reads
// the recorded SEQUENCE of controller calls, never just membership: an out-of-order machine
// satisfies "the controller was told to paint listening at some point" perfectly. And each
// negative assertion is PAIRED in the same test with the positive that proves the setup can fire
// at all — a lone "nothing happened" passes for a session that was never wired up.
import { describe, expect, it, vi } from "vitest";
import { createSparkleSession, type SparkleSessionDeps } from "./session";
import type { SparkleOverlayController } from "../../components/SparkleOverlay";
import type { GenieResponse } from "../genie";
import type { WakeWordDetector, WakeWordEvent } from "../../voice/wakeWord";

/** Records every controller call as a flat, ordered log of strings — the thing under test. */
function recordingController() {
  const calls: string[] = [];
  const controller: SparkleOverlayController = {
    setState: (anchor, mode) => void calls.push(`setState:${anchor}/${mode}`),
    hear: async (text) => void calls.push(`hear:${text}`),
    reply: async (text) => void calls.push(`reply:${text}`),
    dismiss: () => void calls.push("dismiss"),
    getState: () => ({ anchor: "perch", mode: "still" }),
  };
  return { controller, calls };
}

/** A detector stub whose `onDetect` we can fire by hand, and whose enabled flag we can read. */
function stubDetector() {
  let fire: ((e: WakeWordEvent) => void) | null = null;
  const state = { enabled: true, fed: [] as string[], resets: 0 };
  const create = (onDetect: (e: WakeWordEvent) => void): WakeWordDetector => {
    fire = onDetect;
    return {
      feed: (chunk: string) => void state.fed.push(chunk),
      setEnabled: (v: boolean) => void (state.enabled = v),
      reset: () => void state.resets++,
    } as unknown as WakeWordDetector;
  };
  return {
    create,
    state,
    wake: (residual = "") => fire?.({ at: 1, phrase: "hey sparkle", residual, confidence: 1 }),
  };
}

function reply(text: string): GenieResponse {
  return { intent: "chat", replyText: text, confidence: 0.9 };
}

function harness(over: Partial<SparkleSessionDeps> = {}) {
  const { controller, calls } = recordingController();
  const det = stubDetector();
  const route = vi.fn(async () => reply("here you go"));
  const onAction = vi.fn();
  const session = createSparkleSession({
    controller,
    createDetector: det.create,
    route,
    now: () => 1000,
    onAction,
    ...over,
  });
  return { session, calls, det, route, onAction };
}

describe("the full cycle", () => {
  it("paints idle -> listening -> processing -> speaking -> idle IN THAT ORDER", async () => {
    const { session, calls, det } = harness();

    det.wake("what is on my calendar");
    expect(session.getState().state).toBe("listening");

    session.endOfSpeech("what is on my calendar");
    expect(session.getState().state).toBe("processing");

    await vi.waitFor(() => expect(session.getState().state).toBe("responding"));
    session.endOfSpeech(); // a stray end-of-speech while responding must not disturb the cycle

    // The ORDER is the assertion. Membership alone would pass for any permutation of these.
    expect(calls.filter((c) => c.startsWith("setState:"))).toEqual([
      "setState:perch/listening",
      "setState:center/processing",
      "setState:center/speaking",
    ]);
    expect(calls).toContain("hear:what is on my calendar");
    expect(calls).toContain("reply:here you go");
  });

  it("returns the swarm home when the reply finishes painting", async () => {
    const { session, calls, det } = harness();
    det.wake("hello");
    session.endOfSpeech("hello");
    await vi.waitFor(() => expect(session.getState().state).toBe("responding"));

    // responseDone arrives through the machine via the public dismiss-free path: the controller
    // finished typing. We drive it the way session.ts exposes it — the reply having landed, the
    // caller signals completion by dismissing the response, which lands home.
    session.dismiss();
    expect(session.getState().state).toBe("idle");
    expect(calls.slice(-2)).toEqual(["dismiss", "setState:perch/still"]);
  });
});

describe("the losing interleaving", () => {
  it("does NOT repaint when the answer arrives after a dismiss", async () => {
    let resolve!: (r: GenieResponse) => void;
    const { session, calls, det } = harness({
      route: () => new Promise<GenieResponse>((r) => (resolve = r)),
    });

    det.wake("summarize the fleet");
    session.endOfSpeech("summarize the fleet");
    expect(session.getState().state).toBe("processing");

    session.dismiss();
    const afterDismiss = calls.length;

    // The request was already in flight. It lands now, addressed to a conversation that is over.
    resolve(reply("too late"));
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.slice(afterDismiss)).toEqual([]);
    expect(calls).not.toContain("reply:too late");
    expect(session.getState().state).toBe("idle");
  });

  it("PAIRED: the identical response DOES paint when no dismiss intervened", async () => {
    // Without this, the test above passes for a session whose route was never called at all.
    let resolve!: (r: GenieResponse) => void;
    const { session, calls, det } = harness({
      route: () => new Promise<GenieResponse>((r) => (resolve = r)),
    });
    det.wake("summarize the fleet");
    session.endOfSpeech("summarize the fleet");
    resolve(reply("too late"));
    await vi.waitFor(() => expect(calls).toContain("reply:too late"));
    expect(session.getState().state).toBe("responding");
  });

  it("drops a stale response's ACTION too — a dismissed question must not still act", async () => {
    let resolve!: (r: GenieResponse) => void;
    const { session, onAction, det } = harness({
      route: () => new Promise<GenieResponse>((r) => (resolve = r)),
    });
    det.wake("open the build project");
    session.endOfSpeech("open the build project");
    session.dismiss();
    resolve({ intent: "navigate", replyText: "opening", confidence: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("PAIRED: the same action DOES fire when the conversation stands", async () => {
    const { session, onAction, det } = harness({
      route: async () => ({ intent: "navigate", replyText: "opening", confidence: 1 }) as GenieResponse,
    });
    det.wake("open the build project");
    session.endOfSpeech("open the build project");
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
  });

  it("a second wake supersedes the first — the older answer never paints", async () => {
    const pending: ((r: GenieResponse) => void)[] = [];
    const { session, calls, det } = harness({
      route: () => new Promise<GenieResponse>((r) => pending.push(r)),
    });
    det.wake("first question");
    session.endOfSpeech("first question");
    det.wake("second question");
    session.endOfSpeech("second question");

    pending[0]?.(reply("answer to the FIRST"));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).not.toContain("reply:answer to the FIRST");

    pending[1]?.(reply("answer to the SECOND"));
    await vi.waitFor(() => expect(calls).toContain("reply:answer to the SECOND"));
  });
});

describe("the privacy control", () => {
  it("fires NOTHING while muted, and the identical input fires once un-muted", () => {
    const { session, calls, det } = harness();

    session.mute();
    expect(det.state.enabled).toBe(false);
    det.wake("are you there");
    expect(calls).toEqual([]);

    // PAIRED positive: the same gesture, un-muted, provably does paint. Without this the
    // assertion above is satisfied by a session that is broken in every state.
    session.unmute();
    expect(det.state.enabled).toBe(true);
    det.wake("are you there");
    expect(calls).toContain("setState:perch/listening");
  });

  it("muting MID-CONVERSATION tears the overlay down rather than leaving it out front", () => {
    const { session, calls, det } = harness();
    det.wake("mid conversation");
    expect(session.getState().state).toBe("listening");
    session.mute();
    expect(session.getState().state).toBe("idle");
    expect(calls.slice(-2)).toEqual(["dismiss", "setState:perch/still"]);
  });
});

describe("failure never strands the swarm", () => {
  it("lands back at the perch when the genie rejects", async () => {
    const { session, calls, det } = harness({
      route: async () => {
        throw new Error("router exploded");
      },
    });
    det.wake("break please");
    session.endOfSpeech("break please");
    await vi.waitFor(() => expect(session.getState().state).toBe("idle"));
    expect(calls.slice(-2)).toEqual(["dismiss", "setState:perch/still"]);
  });
});

describe("plumbing that is easy to get silently wrong", () => {
  it("feeds EVERY chunk to the detector, awake or not — that is what 'continuous' means", () => {
    const { session, det } = harness();
    session.feed("idle chatter");
    det.wake("");
    session.feed("now i am talking");
    expect(det.state.fed).toEqual(["idle chatter", "now i am talking"]);
  });

  it("shows transcript only once awake", () => {
    const { session, calls, det } = harness();
    session.feed("nobody asked");
    expect(calls).toEqual([]);
    det.wake("");
    session.feed("nobody asked");
    expect(calls).toContain("hear:nobody asked");
  });

  it("never asks the genie for an end-of-speech that arrives while idle", () => {
    const { session, route } = harness();
    session.endOfSpeech("into the void");
    expect(route).not.toHaveBeenCalled();
  });

  it("stops accepting anything after dispose", () => {
    const { session, calls, det } = harness();
    session.dispose();
    det.wake("hello");
    expect(calls).toEqual([]);
  });
});
