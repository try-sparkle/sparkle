import { beforeEach, describe, expect, it } from "vitest";
import { limitKey, raiseFirstLimit, useAccountLimitStore } from "./accountLimitStore";

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
});
