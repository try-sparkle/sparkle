import { beforeEach, describe, expect, it } from "vitest";
import {
  limitKey,
  raiseFirstLimit,
  raiseFirstLimitUnlessAutoSwitchHandles,
  useAccountLimitStore,
} from "./accountLimitStore";

const reset = () => useAccountLimitStore.setState({ current: null, dismissed: new Set() });
const state = () => useAccountLimitStore.getState();

describe("accountLimitStore", () => {
  beforeEach(reset);

  it("raises a limit so the modal has something to show", () => {
    state().raise({ accountId: "a", until: 100 });
    expect(state().current).toEqual({ accountId: "a", until: 100 });
  });

  it("does not re-raise a limit the user already dismissed", () => {
    state().raise({ accountId: "a", until: 100 });
    state().dismiss();
    state().raise({ accountId: "a", until: 100 });
    expect(state().current).toBeNull();
  });

  // The dismissal key is (account, reset instant), not the account alone. Keying on the account
  // would silence every FUTURE limit on it after one dismissal — i.e. the founder dismisses once at
  // 9am and is never told again, which is the whole feature gone.
  it("re-raises when the SAME account hits a LATER limit", () => {
    state().raise({ accountId: "a", until: 100 });
    state().dismiss();
    state().raise({ accountId: "a", until: 999 });
    expect(state().current).toEqual({ accountId: "a", until: 999 });
  });

  it("keeps the first limit on screen rather than queueing a second", () => {
    state().raise({ accountId: "a", until: 100 });
    state().raise({ accountId: "b", until: 200 });
    expect(state().current).toEqual({ accountId: "a", until: 100 });
  });

  it("dismiss is a no-op when nothing is showing", () => {
    state().dismiss();
    expect(state().current).toBeNull();
    expect(state().dismissed.size).toBe(0);
  });

  describe("raiseFirstLimit", () => {
    it("does nothing for an empty batch — the common, unlimited case", () => {
      raiseFirstLimit([]);
      expect(state().current).toBeNull();
    });

    // A batch is usually ONE limit fanned across every registration of the same login. The account
    // the user feels first is the one whose bench ends soonest.
    it("picks the earliest-resetting account out of a fanned-out batch", () => {
      raiseFirstLimit([
        { accountId: "late", until: 500 },
        { accountId: "early", until: 200 },
        { accountId: "middle", until: 300 },
      ]);
      expect(state().current).toEqual({ accountId: "early", until: 200 });
    });
  });

  it("limitKey distinguishes the same account at different reset instants", () => {
    expect(limitKey({ accountId: "a", until: 1 })).not.toBe(limitKey({ accountId: "a", until: 2 }));
  });

  // The modal is the FALLBACK for "nowhere to switch TO". These pin that it stays down when
  // auto-switch has a target, and shows only when it does not — the founder's exact complaint was
  // getting the manual "log in to another account" modal while auto-switch had a healthy account to
  // move to. The two tests are a PAIR: the same batch, the flag the only difference, so the negative
  // failing while the positive passes is the only outcome consistent with "the flag drives it".
  describe("raiseFirstLimitUnlessAutoSwitchHandles", () => {
    it("SUPPRESSES the modal when auto-switch has a target — the founder is not asked to act", () => {
      raiseFirstLimitUnlessAutoSwitchHandles([{ accountId: "walled", until: 100 }], true);
      // THE SIDE EFFECT: nothing on screen. Auto-switch will migrate the fleet; the modal would be
      // asking the founder to do by hand what the automation is already doing.
      expect(state().current).toBeNull();
    });

    it("RAISES the modal when there is genuinely nowhere to go", () => {
      raiseFirstLimitUnlessAutoSwitchHandles([{ accountId: "walled", until: 100 }], false);
      expect(state().current).toEqual({ accountId: "walled", until: 100 });
    });

    it("still does nothing for an empty batch even when told nothing can handle it", () => {
      raiseFirstLimitUnlessAutoSwitchHandles([], false);
      expect(state().current).toBeNull();
    });
  });

  // The other half of the coordination: once auto-switch STARTS migrating a walled account's fleet,
  // any modal already raised for that account (from a moment when there was no target) is moot and
  // must clear — otherwise the founder is left staring at a "log in to another account" prompt for a
  // fleet the app is already rescuing.
  describe("resolveByAutoSwitch", () => {
    it("clears a modal that is about the account auto-switch just rescued", () => {
      state().raise({ accountId: "walled", until: 100 });
      expect(state().current).not.toBeNull();
      state().resolveByAutoSwitch("walled");
      expect(state().current).toBeNull();
    });

    it("records it dismissed so the same episode cannot re-raise after the migration starts", () => {
      state().raise({ accountId: "walled", until: 100 });
      state().resolveByAutoSwitch("walled");
      // A fresh `raise` for the SAME (account, reset) is swallowed — the episode is resolved.
      state().raise({ accountId: "walled", until: 100 });
      expect(state().current).toBeNull();
    });

    it("leaves a modal about a DIFFERENT account alone — auto-switch did not touch that one", () => {
      state().raise({ accountId: "other", until: 100 });
      state().resolveByAutoSwitch("walled");
      expect(state().current).toEqual({ accountId: "other", until: 100 });
    });

    it("is a no-op when nothing is showing", () => {
      state().resolveByAutoSwitch("walled");
      expect(state().current).toBeNull();
      expect(state().dismissed.size).toBe(0);
    });
  });
});
