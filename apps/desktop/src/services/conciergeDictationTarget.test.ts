// The concierge borrows the app-wide dictation insert target rather than owning it, so the agent
// composer gets it back untouched. These cover the whole borrow/return protocol.
import { describe, expect, it } from "vitest";
import {
  claimDictationTarget,
  releaseDictationTarget,
  type InsertFn,
} from "./conciergeDictationTarget";

function fakeStore(initial: InsertFn | null = null) {
  let target = initial;
  return {
    getInsertTarget: () => target,
    registerInsert: (fn: InsertFn | null) => {
      target = fn;
    },
  };
}

describe("conciergeDictationTarget", () => {
  it("claim installs ours and reports the composer it displaced", () => {
    const composer: InsertFn = () => {};
    const concierge: InsertFn = () => {};
    const store = fakeStore(composer);

    expect(claimDictationTarget(store, concierge)).toBe(composer);
    expect(store.getInsertTarget()).toBe(concierge);
  });

  it("release hands the target straight back to the composer", () => {
    const composer: InsertFn = () => {};
    const concierge: InsertFn = () => {};
    const store = fakeStore(composer);

    const displaced = claimDictationTarget(store, concierge);
    releaseDictationTarget(store, concierge, displaced);

    expect(store.getInsertTarget()).toBe(composer);
  });

  it("claiming with nothing registered releases back to null", () => {
    const concierge: InsertFn = () => {};
    const store = fakeStore(null);

    const displaced = claimDictationTarget(store, concierge);
    expect(displaced).toBeNull();
    releaseDictationTarget(store, concierge, displaced);
    expect(store.getInsertTarget()).toBeNull();
  });

  it("release never evicts a composer that claimed the target after us", () => {
    const composer: InsertFn = () => {};
    const concierge: InsertFn = () => {};
    const newcomer: InsertFn = () => {};
    const store = fakeStore(composer);

    const displaced = claimDictationTarget(store, concierge);
    store.registerInsert(newcomer); // a pane became visible mid-session
    releaseDictationTarget(store, concierge, displaced);

    expect(store.getInsertTarget()).toBe(newcomer);
  });

  it("a re-claim while we already hold it reports no displaced holder to strand", () => {
    const composer: InsertFn = () => {};
    const concierge: InsertFn = () => {};
    const store = fakeStore(composer);

    claimDictationTarget(store, concierge);
    expect(claimDictationTarget(store, concierge)).toBeNull();
  });
});
