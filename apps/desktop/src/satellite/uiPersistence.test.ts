// @vitest-environment jsdom
//
// A satellite READS the user's UI preferences and never writes them back.
//
// Both halves matter and they pull against each other. `sparkle-ui` is one zustand-persisted blob,
// and zustand republishes the WHOLE partialized state on every change — so a satellite touching any
// ui field would rewrite main's tab order, pin and open-project set from its own partial view of
// them. But simply handing the store an empty storage would also stop it hydrating, and the
// satellite would render with default zoom and the wrong theme.
//
// Hence read-THROUGH, write-DROP. The read has to be a live passthrough rather than a snapshot
// because `freezeUiPersistence` runs before the store has necessarily hydrated.
import { describe, it, expect, beforeEach } from "vitest";
import { readOnlyLocalStorage, freezeUiPersistence } from "./uiPersistence";
import { useUiStore } from "../stores/uiStore";

const KEY = "sparkle-ui";

beforeEach(() => {
  localStorage.clear();
});

describe("readOnlyLocalStorage", () => {
  it("reads through to the real localStorage", () => {
    localStorage.setItem(KEY, '{"state":{"zoom":3},"version":0}');
    expect(readOnlyLocalStorage().getItem(KEY)).toBe('{"state":{"zoom":3},"version":0}');
  });

  it("drops writes and removals instead of throwing", () => {
    localStorage.setItem(KEY, "original");
    const s = readOnlyLocalStorage();
    s.setItem(KEY, "clobbered");
    s.removeItem?.(KEY);
    // Silently ignoring a write is the contract: zustand calls setItem on every state change and a
    // throw would surface as an unhandled rejection on an ordinary UI interaction.
    expect(localStorage.getItem(KEY)).toBe("original");
  });
});

describe("freezeUiPersistence", () => {
  it("stops a uiStore change from rewriting main's blob, while the value still hydrates", async () => {
    // Main's persisted state, as it would be on disk when the satellite boots.
    localStorage.setItem(KEY, JSON.stringify({ state: { pinnedProjectId: "p-main" }, version: 0 }));
    freezeUiPersistence();

    // Hydration still works — this is the half a naive "give it an empty store" fix would break.
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().pinnedProjectId).toBe("p-main");

    // …and now a write this window makes must not reach the blob. `setActiveSpecial` is the
    // realistic trigger: SatelliteApp calls it on mount to clear an inherited "sparkle" view.
    useUiStore.getState().setActiveSpecial("sparkle");
    expect(JSON.parse(localStorage.getItem(KEY)!).state.pinnedProjectId).toBe("p-main");
    expect(JSON.parse(localStorage.getItem(KEY)!).state.activeSpecial).toBeUndefined();
  });
});
