// The REAL wiring, exercised without injecting any of it (bead sparkle-uz87.7).
//
// WHY THIS FILE EXISTS SEPARATELY. Every test in session.test.ts supplies its own detector and its
// own router, which is what makes those tests fast and deterministic — and also what would leave
// `defaultSessionDeps()` covered by nothing at all. In this repo that is a known way to ship a
// dead feature (`sparkle-lgbwf`, seen 4x): delete the line that supplies the real value and the
// suite stays green while the app does nothing. So this file injects NOTHING but the controller
// (which needs a canvas) and drives the genuine wake-word detector and the genuine genie router
// end to end.
import { describe, expect, it, vi } from "vitest";
import { createSparkleSession, defaultSessionDeps } from "./session";
import type { SparkleOverlayController } from "../../components/SparkleOverlay";
import type { GenieResponse } from "../genie";
import { ON_DEVICE_ORIGIN } from "../../voice/wakeWord";

function recordingController(opts: { deferReply?: boolean } = {}) {
  const calls: string[] = [];
  const gates: (() => void)[] = [];
  const controller: SparkleOverlayController = {
    setState: (anchor, mode) => void calls.push(`setState:${anchor}/${mode}`),
    hear: async (text) => void calls.push(`hear:${text}`),
    // The real controller resolves this when the typing animation ends, and that resolution is
    // what closes the cycle. Holding it open is the only way `responding` is observable at all.
    reply: async (text) => {
      calls.push(`reply:${text}`);
      if (opts.deferReply) await new Promise<void>((r) => gates.push(r));
    },
    dismiss: () => void calls.push("dismiss"),
    getState: () => ({ anchor: "perch", mode: "still" }),
  };
  const finishReply = () => {
    const g = gates.shift();
    if (!g) return false;
    g();
    return true;
  };
  return { controller, calls, finishReply };
}

describe("defaultSessionDeps — the real detector and the real router", () => {
  it("drives the WHOLE ring — wake, listen, process, respond, home — with nothing stubbed", async () => {
    const { controller, calls, finishReply } = recordingController({ deferReply: true });
    const actions: GenieResponse[] = [];
    const session = createSparkleSession(
      defaultSessionDeps(controller, (r) => void actions.push(r)),
    );

    // A real transcript chunk, exactly as the dictation path emits it. If the real detector were
    // not wired in, this produces nothing at all.
    session.feed("hey sparkle what is the fleet doing", ON_DEVICE_ORIGIN);
    expect(session.getState().state).toBe("listening");
    expect(calls).toContain("setState:perch/listening");
    // The residual is the real wakePhrase extraction, not a fixture.
    expect(calls).toContain("hear:what is the fleet doing");

    session.endOfSpeech();
    expect(session.getState().state).toBe("processing");
    expect(calls).toContain("setState:center/processing");

    // The real router classifies and answers. We assert the SHAPE reached the controller rather
    // than the exact wording, so this stays a wiring test and does not re-pin the classifier's
    // own rules (those have their own suite).
    await new Promise((r) => setTimeout(r, 0));
    expect(session.getState().state).toBe("responding");
    expect(calls).toContain("setState:center/speaking");
    expect(calls.some((c) => c.startsWith("reply:") && c.length > "reply:".length)).toBe(true);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.intent).toBe("status");

    // THE LEG THAT DID NOT EXIST. The reply finishes typing, and the real wiring — not a
    // dismiss, not a test-only event — must carry the swarm home. Before `responseDone` had a
    // caller, this session parked in center/speaking forever.
    expect(finishReply()).toBe(true);
    await vi.waitFor(() => expect(session.getState().state).toBe("idle"));

    // The ORDER of the whole ring, end to end, through the real detector and the real router.
    expect(calls.filter((c) => c.startsWith("setState:"))).toEqual([
      "setState:perch/listening",
      "setState:center/processing",
      "setState:center/speaking",
      "setState:perch/still",
    ]);

    session.dispose();
  });

  it("the real detector stays silent for speech that does not contain the wake phrase", async () => {
    const { controller, calls } = recordingController();
    const session = createSparkleSession(defaultSessionDeps(controller));

    session.feed("just talking to a colleague about sparkles in general", ON_DEVICE_ORIGIN);
    expect(calls).toEqual([]);
    expect(session.getState().state).toBe("idle");

    // PAIRED: the same real detector DOES fire for the phrase, so the silence above is a real
    // negative and not a session that was never wired up.
    session.feed("hey sparkle hello", ON_DEVICE_ORIGIN);
    expect(session.getState().state).toBe("listening");

    session.dispose();
  });

  it("the REAL gate refuses cloud text — the same words that wake it when heard on-device", () => {
    // This is the join, asserted end to end through defaultSessionDeps: the production wiring
    // takes the ORIGIN-GATED factory, not the ungated one. Swap it back and this goes red.
    const { controller, calls } = recordingController();
    const session = createSparkleSession(defaultSessionDeps(controller));

    session.feed("hey sparkle what is the fleet doing", "cloud");
    expect(session.getState().state).toBe("idle");
    expect(calls).toEqual([]);

    session.feed("hey sparkle what is the fleet doing", "unknown");
    expect(session.getState().state).toBe("idle");
    expect(calls).toEqual([]);

    // PAIRED, and byte-identical but for the origin: on-device, the very same sentence wakes it.
    // Without this the refusals above are satisfied by a session that never wired a detector.
    session.feed("hey sparkle what is the fleet doing", ON_DEVICE_ORIGIN);
    expect(session.getState().state).toBe("listening");
    expect(calls).toContain("setState:perch/listening");

    session.dispose();
  });
});
