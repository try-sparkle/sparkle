// @vitest-environment jsdom
//
// The ownership rule is the part of the concierge mic that can quietly break the rest of the app:
// dictationStore holds ONE insert target for every window, and the concierge column is mounted for
// the whole session. These pin down that it borrows the target only while the mic is routing AND
// the concierge is the surface the user is talking to.
//
// The box no longer has a mic button, so none of this is driven by a click on it any more. The
// gestures below are what the REAL surfaces do to the store: the header ring sets voiceSurface
// "concierge" and arms (LogoWaveform + MicMenu), an agent composer's mic sets "agent"
// (MicButton.ComposerMic), and the wake word just moves `phase` with no click at all. That last
// one is the case the old click-driven claim could not serve, and is why this file exists in this
// shape.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useConciergeDictation } from "./useConciergeDictation";
import { useAuthStore } from "./stores/authStore";
import { useDictationStore } from "./stores/dictationStore";

const composerTarget = (text: string) => void text;

beforeEach(() => {
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents: 500, tokenVersion: 1 },
  });
  useDictationStore.setState({
    enabled: false,
    phase: "passive",
    interim: "",
    insertTarget: composerTarget,
    outOfCreditsNotice: false,
    voiceSurface: "concierge",
  });
});

// vitest runs without globals here, so @testing-library's auto-cleanup never registers itself and
// hooks stay mounted after their test ends. That was harmless while ownership came from a click on
// the box — a stale hook never clicked anything. It is not harmless now: ownership is derived from
// store state, so every leftover instance re-claims the moment the store says "routing here", and
// the leftovers fight the live one over the single app-wide target.
afterEach(() => cleanup());

function mountBox() {
  const hook = renderHook(() => useConciergeDictation());
  const append = vi.fn();
  act(() => hook.result.current.registerInsert(append));
  return { hook, append };
}

/** What the header ring does when the user sets it to "Listening": names itself the voice surface,
 *  arms the mic, routes speech. (MicMenu records the surface, useMicActions.setActive does the
 *  rest — see MicButton.) */
function armFromRing() {
  act(() => {
    const s = useDictationStore.getState();
    s.setVoiceSurface("concierge");
    s.setEnabled(true);
    s.setPhase("active");
  });
}

/** What an AGENT composer's own mic does — the other half of the arbiter. */
function armFromAgentComposer(append: (t: string) => void) {
  act(() => {
    const s = useDictationStore.getState();
    s.setVoiceSurface("agent");
    s.registerInsert(append);
    s.setEnabled(true);
    s.setPhase("active");
  });
}

describe("useConciergeDictation", () => {
  it("does NOT take the app-wide target just because the box is mounted", () => {
    mountBox();
    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);
  });

  it("arming from the header ring borrows the target — no click on the box required", () => {
    // THE REGRESSION THIS FILE EXISTS FOR. The box's own mic button used to be the only thing that
    // claimed, so once it was removed, arming from the ring left speech going to whichever agent
    // pane had last mounted: the ring said "Actively listening" and nothing appeared in the box.
    const { hook, append } = mountBox();
    armFromRing();

    const s = useDictationStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.phase).toBe("active");
    expect(s.insertTarget).toBe(append);
    expect(hook.result.current.micLive).toBe(true);
  });

  it("the WAKE WORD routes here too, with no click anywhere", () => {
    // Armed and passive is the resting state the ring's caption invites ("Mic paused. Say Hey
    // Sparkle to activate"). The wake word only moves `phase`, so a claim that needs a click can
    // never fire on this path — which is most of how the mic is actually used.
    const { hook, append } = mountBox();
    act(() => useDictationStore.getState().setEnabled(true));
    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);

    act(() => useDictationStore.getState().setPhase("active"));
    expect(useDictationStore.getState().insertTarget).toBe(append);
    expect(hook.result.current.micLive).toBe(true);
  });

  it("committed segments reach the box while live", () => {
    const { append } = mountBox();
    armFromRing();
    act(() => useDictationStore.getState().insert("approve the deploy"));
    expect(append).toHaveBeenCalledWith("approve the deploy");
  });

  it("muting from the ring hands the target back", () => {
    const { hook } = mountBox();
    armFromRing();
    act(() => useDictationStore.getState().setPhase("passive"));

    const s = useDictationStore.getState();
    expect(s.enabled).toBe(true); // paused, not off — the mic cycle never jumps straight to off
    expect(s.insertTarget).toBe(composerTarget);
    expect(hook.result.current.micLive).toBe(false);
  });

  it("end of speech (the stop word drops phase) releases the target with no click", () => {
    const { hook } = mountBox();
    armFromRing();
    act(() => useDictationStore.getState().setPhase("passive"));

    expect(hook.result.current.micLive).toBe(false);
    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);
  });

  it("turning the mic off entirely releases the target", () => {
    const { hook } = mountBox();
    armFromRing();
    act(() => useDictationStore.getState().setEnabled(false));

    expect(hook.result.current.micLive).toBe(false);
    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);
  });

  it("the live preview is only exposed while we own dictation", () => {
    const { hook } = mountBox();
    act(() => useDictationStore.getState().setInterim("half a phra"));
    expect(hook.result.current.interim).toBe("");

    armFromRing();
    act(() => useDictationStore.getState().setInterim("half a phra"));
    expect(hook.result.current.interim).toBe("half a phra");
  });

  it("a mic armed for an AGENT composer is left alone", () => {
    // The arbiter's whole job. Without it, a concierge that claims on any routing mic would take
    // the transcript straight back off a composer the user just deliberately armed.
    const agentAppend = vi.fn();
    mountBox();
    armFromAgentComposer(agentAppend);

    expect(useDictationStore.getState().insertTarget).toBe(agentAppend);
    act(() => useDictationStore.getState().insert("run the tests"));
    expect(agentAppend).toHaveBeenCalledWith("run the tests");
  });

  it("FOCUSING an agent composer mid-dictation keeps the transcript there", () => {
    // Focus is a claim too, not just a mic click — "whichever compose surface the user is actually
    // in owns the transcript" (Composer.tsx onFocus → claimDictationRef). Since ownership here is
    // derived and re-claims on drift, a focus claim that only called registerInsert would be undone
    // on the very next commit and the words would snap back to the concierge box the user just left.
    // So the focus claim names its surface, exactly as an arm does.
    const agentAppend = vi.fn();
    const { hook } = mountBox();
    armFromRing();

    act(() => {
      // What Composer's onFocus handler does, in order.
      const s = useDictationStore.getState();
      s.setVoiceSurface("agent");
      s.registerInsert(agentAppend);
    });

    expect(useDictationStore.getState().insertTarget).toBe(agentAppend);
    expect(hook.result.current.micLive).toBe(false);
    act(() => useDictationStore.getState().insert("rebase onto main"));
    expect(agentAppend).toHaveBeenCalledWith("rebase onto main");
  });

  it("the agent surface DISAPPEARING mid-session brings dictation back here", () => {
    // voiceSurface only moves when a mic control is operated, so it can outlive the surface it
    // names: arm an agent composer, then close that pane and its cleanup registers null while the
    // mic is still armed. Nobody holds the target, insert() no-ops, and the ring says "Actively
    // listening" while the words go nowhere — this bug's own failure mode, mirrored.
    const agentAppend = vi.fn();
    const { hook, append } = mountBox();
    armFromAgentComposer(agentAppend);
    expect(useDictationStore.getState().insertTarget).toBe(agentAppend);

    act(() => useDictationStore.getState().registerInsert(null)); // the pane closes

    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
    expect(useDictationStore.getState().insertTarget).toBe(append);
    expect(hook.result.current.micLive).toBe(true);
    act(() => useDictationStore.getState().insert("what broke?"));
    expect(append).toHaveBeenCalledWith("what broke?");
  });

  it("switching surfaces mid-session moves dictation, both ways", () => {
    const agentAppend = vi.fn();
    const { hook, append } = mountBox();

    armFromRing();
    expect(useDictationStore.getState().insertTarget).toBe(append);

    // User arms the agent composer's own mic: we let go, and hand back what we displaced.
    armFromAgentComposer(agentAppend);
    expect(useDictationStore.getState().insertTarget).toBe(agentAppend);
    expect(hook.result.current.micLive).toBe(false);

    // …and back to the ring.
    armFromRing();
    expect(useDictationStore.getState().insertTarget).toBe(append);
    expect(hook.result.current.micLive).toBe(true);
  });

  it("an agent pane that mounts mid-dictation does not steal the transcript", () => {
    // Composer.tsx registers its append unconditionally when a pane mounts or becomes active — it
    // is not an arm gesture and must not read as one. We notice and take the target back, so the
    // words keep landing where the user is looking.
    const { hook, append } = mountBox();
    armFromRing();

    const mountingPane = vi.fn();
    act(() => useDictationStore.getState().registerInsert(mountingPane));

    expect(useDictationStore.getState().insertTarget).toBe(append);
    expect(hook.result.current.micLive).toBe(true);
    act(() => useDictationStore.getState().insert("still mine"));
    expect(append).toHaveBeenCalledWith("still mine");
    expect(mountingPane).not.toHaveBeenCalled();
  });

  it("re-claiming after an interloper still restores the ORIGINAL composer on release", () => {
    // The displaced holder recorded at the start of the episode is the one to hand back to — not
    // whichever pane happened to register over us in the middle of it.
    const { hook } = mountBox();
    armFromRing();
    act(() => useDictationStore.getState().registerInsert(vi.fn()));
    act(() => useDictationStore.getState().setPhase("passive"));

    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);
    expect(hook.result.current.micLive).toBe(false);
  });

  it("the box unregistering while live hands the target back (a child unmounts first)", () => {
    const { hook } = mountBox();
    armFromRing();
    act(() => hook.result.current.registerInsert(null));

    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);
    expect(hook.result.current.micLive).toBe(false);
  });

  it("re-registering a NEW append while live keeps dictation on the box (roborev 49293)", () => {
    // ConciergeHost wraps the box's append in a fresh arrow on every call, so a re-registration is
    // an identity change every time. Releasing without re-claiming would hand the app-wide target
    // back to the agent composer we displaced while the concierge box is still on screen — the mic
    // keeps transcribing and the words land in an off-screen box.
    const { hook } = mountBox();
    armFromRing();
    const next = vi.fn();
    act(() => hook.result.current.registerInsert(next));

    expect(useDictationStore.getState().insertTarget).toBe(next);
    expect(hook.result.current.micLive).toBe(true);
    act(() => useDictationStore.getState().insert("still listening"));
    expect(next).toHaveBeenCalledWith("still listening");
    // …and the composer we displaced is still what a later release restores.
    act(() => hook.result.current.registerInsert(null));
    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);
  });

  it("a box that registers while the mic is ALREADY live claims on the spot", () => {
    // Cold start with a persisted armed mic: the store is routing here before the box has handed
    // over its append fn. Filling a ref re-runs no effect, so the registration itself has to claim.
    act(() => {
      const s = useDictationStore.getState();
      s.setVoiceSurface("concierge");
      s.setEnabled(true);
      s.setPhase("active");
    });
    const { hook, append } = mountBox();

    expect(useDictationStore.getState().insertTarget).toBe(append);
    expect(hook.result.current.micLive).toBe(true);
  });

  it("re-registering while NOT live claims nothing", () => {
    const { hook } = mountBox();
    act(() => hook.result.current.registerInsert(vi.fn()));
    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);
    expect(hook.result.current.micLive).toBe(false);
  });

  it("unmounting hands the target back rather than stranding it", () => {
    const { hook } = mountBox();
    armFromRing();
    hook.unmount();
    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);
  });
});
