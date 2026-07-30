// The store's RESET, which every audio-input suite's `beforeEach` now depends on.
//
// This file exists because the hand-listed alternative already failed in the way that matters.
// `grantPending` was added to this store precisely so a suite's reset could reach it — and only one
// of the three `setState` call sites was updated, leaving the picker suite (where in-flight grants
// are actually held open) able to carry a stale `true` from one test into the next (roborev 55871).
// zustand's `setState` MERGES, so an omitted field is silently retained rather than reset, and the
// consequence is invisible: the next grant returns at the dedupe guard having invoked nothing while
// store-based assertions pass off state a previous test left behind.
//
// So the reset is one exported helper, and this is the test that keeps it honest. It asserts every
// field individually rather than a whole-object equality, because the failure mode being guarded is
// "one field was forgotten" and the message should name which one.
import { describe, expect, it } from "vitest";
import { resetAudioInputStore, useAudioInputStore } from "./audioInputStore";

describe("resetAudioInputStore", () => {
  it("clears EVERY field, including the ones a hand-listed reset forgot", () => {
    // Dirty all of it, so no assertion below can pass merely because the field was already at its
    // default when the test started.
    useAudioInputStore.setState({
      devices: [{ uid: "hal-loopback", name: "BlackHole 2ch", isDefault: false, isVirtual: true, isBuiltin: false }],
      chosenUid: "hal-loopback",
      allowVirtual: true,
      bound: { name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true },
      intentEpoch: 7,
      grantFailed: true,
      grantPending: true,
    });

    resetAudioInputStore();

    const s = useAudioInputStore.getState();
    expect(s.devices).toEqual([]);
    expect(s.chosenUid).toBeNull();
    // Fail CLOSED is the store's documented default and the one this must never get wrong: a reset
    // that left the opt-in ON would make a virtual input selectable for a permission nobody granted.
    expect(s.allowVirtual).toBe(false);
    expect(s.bound).toBeNull();
    expect(s.intentEpoch).toBe(0);
    expect(s.grantFailed).toBe(false);
    // THE FIELD THAT WAS FORGOTTEN. A stale `true` here silently no-ops every later grant in a
    // suite, which is the vacuous-test mode this whole helper exists to prevent.
    expect(s.grantPending).toBe(false);
  });
});
