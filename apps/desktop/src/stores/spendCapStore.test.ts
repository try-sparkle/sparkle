// @vitest-environment jsdom
//
// The cap store's two doors: `setCapUsd`, and REHYDRATION — which is the one a bad value actually
// comes through, since a hand-edited or half-written localStorage entry never passes the setter.
import { beforeEach, describe, expect, it } from "vitest";

import { SPEND_CAP_PERSIST_KEY, useSpendCapStore } from "./spendCapStore";

/** Seed localStorage, then rehydrate the live store from it the way a cold start would. */
async function rehydrateFrom(state: unknown): Promise<number | null> {
  localStorage.setItem(SPEND_CAP_PERSIST_KEY, JSON.stringify({ state, version: 0 }));
  await useSpendCapStore.persist.rehydrate();
  return useSpendCapStore.getState().capUsd;
}

beforeEach(() => {
  localStorage.clear();
  useSpendCapStore.setState({ capUsd: null });
});

describe("spendCapStore", () => {
  it("ships with NO cap", () => {
    expect(useSpendCapStore.getState().capUsd).toBeNull();
  });

  it("keeps a real cap the user sets", () => {
    useSpendCapStore.getState().setCapUsd(25);
    expect(useSpendCapStore.getState().capUsd).toBe(25);
  });

  it("treats clearing the field as no cap rather than a cap of zero", () => {
    useSpendCapStore.getState().setCapUsd(25);
    useSpendCapStore.getState().setCapUsd(null);
    expect(useSpendCapStore.getState().capUsd).toBeNull();
  });

  it("refuses a non-positive cap through the setter", () => {
    useSpendCapStore.getState().setCapUsd(0);
    expect(useSpendCapStore.getState().capUsd).toBeNull();
    useSpendCapStore.getState().setCapUsd(-3);
    expect(useSpendCapStore.getState().capUsd).toBeNull();
  });

  it("restores a persisted cap", async () => {
    expect(await rehydrateFrom({ capUsd: 12.5 })).toBe(12.5);
  });

  it("reads a CORRUPTED persisted cap as off, not as a cap of $0", async () => {
    // THE SIDE EFFECT: a $0 cap would report every agent on the pane as over budget, permanently,
    // with no way for the user to see why. Every malformed shape has to land on `null`.
    expect(await rehydrateFrom({ capUsd: 0 })).toBeNull();
    expect(await rehydrateFrom({ capUsd: -1 })).toBeNull();
    expect(await rehydrateFrom({ capUsd: "25" })).toBeNull();
    expect(await rehydrateFrom({ capUsd: null })).toBeNull();
    expect(await rehydrateFrom({})).toBeNull();
  });

  it("keeps the setter callable after rehydrating a record that has none", async () => {
    // The persisted blob carries only data; merging it wholesale would drop the action and the
    // pane's cap input would throw the first time anyone typed in it.
    await rehydrateFrom({ capUsd: 5 });
    expect(typeof useSpendCapStore.getState().setCapUsd).toBe("function");
    useSpendCapStore.getState().setCapUsd(7);
    expect(useSpendCapStore.getState().capUsd).toBe(7);
  });
});
