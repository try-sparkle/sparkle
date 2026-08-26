// The REAL wiring, exercised without injecting any of it (bead sparkle-uz87.7).
//
// WHY THIS FILE EXISTS SEPARATELY. Every test in session.test.ts supplies its own detector and its
// own router, which is what makes those tests fast and deterministic — and also what would leave
// `defaultSessionDeps()` covered by nothing at all. In this repo that is a known way to ship a
// dead feature (`sparkle-lgbwf`, seen 4x): delete the line that supplies the real value and the
// suite stays green while the app does nothing. So this file injects NOTHING but the controller
// (which needs a canvas) and drives the genuine wake-word detector and the genuine genie router
// end to end.
import { describe, expect, it } from "vitest";
import { createSparkleSession, defaultSessionDeps } from "./session";
import type { SparkleOverlayController } from "../../components/SparkleOverlay";
import type { GenieResponse } from "../genie";

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

describe("defaultSessionDeps — the real detector and the real router", () => {
  it("wakes on a spoken phrase and answers it, with nothing stubbed", async () => {
    const { controller, calls } = recordingController();
    const actions: GenieResponse[] = [];
    const session = createSparkleSession(
      defaultSessionDeps(controller, (r) => void actions.push(r)),
    );

    // A real transcript chunk, exactly as the dictation path emits it. If the real detector were
    // not wired in, this produces nothing at all.
    session.feed("hey sparkle what is the fleet doing");
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

    session.dispose();
  });

  it("the real detector stays silent for speech that does not contain the wake phrase", async () => {
    const { controller, calls } = recordingController();
    const session = createSparkleSession(defaultSessionDeps(controller));

    session.feed("just talking to a colleague about sparkles in general");
    expect(calls).toEqual([]);
    expect(session.getState().state).toBe("idle");

    // PAIRED: the same real detector DOES fire for the phrase, so the silence above is a real
    // negative and not a session that was never wired up.
    session.feed("hey sparkle hello");
    expect(session.getState().state).toBe("listening");

    session.dispose();
  });
});
