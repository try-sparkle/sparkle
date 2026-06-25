/**
 * crossWindowSync tests — node env. We mock @tauri-apps/api/event (mirrors
 * useDictation.test.ts) and shim a minimal `window` with __TAURI_INTERNALS__ so the
 * in-Tauri broadcast path is exercised without a real webview.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const emit = vi.fn();
let captured: ((e: { payload: unknown }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...a: unknown[]) => emit(...a),
  listen: (_name: string, cb: (e: { payload: unknown }) => void) => {
    captured = cb;
    return Promise.resolve(() => {});
  },
}));

import { subscribeToCrossWindowSync } from "./crossWindowSync";
import { useProjectStore } from "../stores/projectStore";

let unsub: () => void = () => {};

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  localStorage.clear();
  emit.mockClear();
  captured = null;
  // Minimal window shim: addEventListener/removeEventListener + the Tauri marker.
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    __TAURI_INTERNALS__: {},
  };
});

afterEach(() => {
  unsub();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("subscribeToCrossWindowSync", () => {
  it("broadcasts on a structural change (addProject)", () => {
    unsub = subscribeToCrossWindowSync();
    useProjectStore.getState().addProject("P", "/tmp/p");
    expect(emit).toHaveBeenCalledWith("sparkle://projects-changed");
  });

  it("does NOT broadcast on a non-structural change (appendPrompt)", () => {
    const id = useProjectStore.getState().addProject("P", "/tmp/p");
    const agentId = useProjectStore.getState().addAgent(id);
    unsub = subscribeToCrossWindowSync();
    emit.mockClear();
    useProjectStore.getState().appendPrompt(id, agentId, "typing a long prompt...");
    expect(emit).not.toHaveBeenCalled();
  });

  it("rehydrates when a remote change event arrives", () => {
    const rehydrate = vi
      .spyOn(useProjectStore.persist, "rehydrate")
      .mockResolvedValue(undefined as unknown as void);
    unsub = subscribeToCrossWindowSync();
    expect(captured).not.toBeNull();
    captured?.({ payload: undefined });
    expect(rehydrate).toHaveBeenCalled();
    rehydrate.mockRestore();
  });

  it("does NOT re-broadcast after a remote event (no rehydrate→emit loop)", async () => {
    // Real (unmocked) persist.rehydrate mutates the store via set(), which fires the subscriber
    // *during* applyingRemote. The guard must swallow that write so we don't echo a new event.
    useProjectStore.getState().addProject("P", "/tmp/p");
    unsub = subscribeToCrossWindowSync();
    emit.mockClear();
    captured?.({ payload: undefined });
    // Let rehydrate's promise + .finally settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).not.toHaveBeenCalled();
  });
});
