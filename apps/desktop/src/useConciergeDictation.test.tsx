// @vitest-environment jsdom
//
// The ownership rule is the part of the concierge mic that can quietly break the rest of the app:
// dictationStore holds ONE insert target for every window, and the concierge column is mounted for
// the whole session. These pin down that it borrows the target only while its own mic is live.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  });
});

function mountBox() {
  const hook = renderHook(() => useConciergeDictation());
  const append = vi.fn();
  act(() => hook.result.current.registerInsert(append));
  return { hook, append };
}

describe("useConciergeDictation", () => {
  it("does NOT take the app-wide target just because the box is mounted", () => {
    mountBox();
    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);
  });

  it("mic press arms the mic, routes speech, and borrows the target", () => {
    const { hook, append } = mountBox();
    act(() => hook.result.current.toggleMic());

    const s = useDictationStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.phase).toBe("active");
    expect(s.insertTarget).toBe(append);
    expect(hook.result.current.micLive).toBe(true);
  });

  it("committed segments reach the box while live", () => {
    const { hook, append } = mountBox();
    act(() => hook.result.current.toggleMic());
    act(() => useDictationStore.getState().insert("approve the deploy"));
    expect(append).toHaveBeenCalledWith("approve the deploy");
  });

  it("pressing again pauses (never releases the mic) and hands the target back", () => {
    const { hook } = mountBox();
    act(() => hook.result.current.toggleMic());
    act(() => hook.result.current.toggleMic());

    const s = useDictationStore.getState();
    expect(s.phase).toBe("passive");
    expect(s.enabled).toBe(true); // paused, not off — the legacy mic cycle
    expect(s.insertTarget).toBe(composerTarget);
    expect(hook.result.current.micLive).toBe(false);
  });

  it("end of speech (the stop word drops phase) releases the target with no click", () => {
    const { hook } = mountBox();
    act(() => hook.result.current.toggleMic());
    act(() => useDictationStore.getState().setPhase("passive"));

    expect(hook.result.current.micLive).toBe(false);
    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);
  });

  it("the live preview is only exposed while we own dictation", () => {
    const { hook } = mountBox();
    act(() => useDictationStore.getState().setInterim("half a phra"));
    expect(hook.result.current.interim).toBe("");

    act(() => hook.result.current.toggleMic());
    act(() => useDictationStore.getState().setInterim("half a phra"));
    expect(hook.result.current.interim).toBe("half a phra");
  });

  it("out of credits: the arm is refused, so nothing is claimed", () => {
    useAuthStore.setState({
      me: { clerkUserId: "u1", entitled: true, balanceCents: 0, tokenVersion: 1 },
    });
    const { hook } = mountBox();
    act(() => hook.result.current.toggleMic());

    const s = useDictationStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.outOfCreditsNotice).toBe(true);
    expect(s.insertTarget).toBe(composerTarget);
    expect(hook.result.current.micLive).toBe(false);
  });

  it("the box unregistering while live hands the target back (a child unmounts first)", () => {
    const { hook } = mountBox();
    act(() => hook.result.current.toggleMic());
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
    act(() => hook.result.current.toggleMic());
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

  it("re-registering while NOT live claims nothing", () => {
    const { hook } = mountBox();
    act(() => hook.result.current.registerInsert(vi.fn()));
    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);
    expect(hook.result.current.micLive).toBe(false);
  });

  it("unmounting hands the target back rather than stranding it", () => {
    const { hook } = mountBox();
    act(() => hook.result.current.toggleMic());
    hook.unmount();
    expect(useDictationStore.getState().insertTarget).toBe(composerTarget);
  });

  it("release never evicts a composer that claimed the target after us", () => {
    const later = (text: string) => void text;
    const { hook } = mountBox();
    act(() => hook.result.current.toggleMic());
    act(() => useDictationStore.getState().registerInsert(later));
    act(() => hook.result.current.toggleMic());
    expect(useDictationStore.getState().insertTarget).toBe(later);
  });
});
