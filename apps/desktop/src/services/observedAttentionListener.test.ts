// The transport half. `engine/observedAttention` proves the RULE and
// `observedAttentionPublished.test.ts` proves the rule is REACHED from the store; this proves the
// store is FILLED — the third link, and the one whose failure would be silent.
//
// The `listen` mock captures handlers and its unlisten really detaches, so a teardown assertion
// cannot pass against a listener that was never armed (the shape `aiServiceHealthListener.test.ts`
// documents).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let handlers: Array<(e: { payload: unknown }) => void> = [];
const unlistenSpy = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, cb: (e: { payload: unknown }) => void) => {
    handlers.push(cb);
    return Promise.resolve(() => {
      handlers = handlers.filter((h) => h !== cb);
      unlistenSpy();
    });
  }),
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { listen } from "@tauri-apps/api/event";
import { useRuntimeStore } from "../stores/runtimeStore";
import {
  OBSERVED_ATTENTION_COMMAND,
  OBSERVED_ATTENTION_EVENT,
  resetObservedAttentionListener,
  startObservedAttentionListener,
} from "./observedAttentionListener";

const payload = (agentId: string, verdict: string, alternate = false) => ({
  agentId,
  verdict,
  alternate,
  atMs: 1_787_251_205_196,
});

const emit = (p: unknown) => handlers.forEach((h) => h({ payload: p }));
const stored = () => useRuntimeStore.getState().observedAttention;

beforeEach(() => {
  handlers = [];
  unlistenSpy.mockClear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  resetObservedAttentionListener();
  useRuntimeStore.getState().seedObservedAttention({});
});

afterEach(() => {
  resetObservedAttentionListener();
  useRuntimeStore.getState().seedObservedAttention({});
});

describe("startObservedAttentionListener", () => {
  it("subscribes to the exact event name the Rust producer emits", async () => {
    await startObservedAttentionListener();
    expect(listen).toHaveBeenCalledWith(OBSERVED_ATTENTION_EVENT, expect.any(Function));
    expect(OBSERVED_ATTENTION_EVENT).toBe("attention://observed");
  });

  it("puts a delivered verdict into the store — the SIDE EFFECT, not the subscription", async () => {
    await startObservedAttentionListener();
    expect(stored().a1).toBeUndefined(); // non-vacuity: nothing there before

    emit(payload("a1", "awaiting"));

    expect(stored().a1).toEqual({ verdict: "awaiting", alternate: false, atMs: 1_787_251_205_196 });
  });

  it("seeds from the pull command, because the event only fires on CHANGE", async () => {
    // A listener that starts late has never seen a verdict, and the frontend starts late every
    // launch. Without the seed an agent parked at a prompt stays wrong until it changes again —
    // which, for an agent waiting on a human, is never.
    invokeMock.mockResolvedValue([payload("a1", "awaiting"), payload("a2", "calm")]);
    await startObservedAttentionListener();
    expect(invokeMock).toHaveBeenCalledWith(OBSERVED_ATTENTION_COMMAND);
    expect(stored().a1?.verdict).toBe("awaiting");
    expect(stored().a2?.verdict).toBe("calm");
  });

  it("lets a reading that arrived DURING the seed win over the older snapshot", async () => {
    // Arming before seeding can only duplicate; the reverse order loses the newer fact. This pins
    // the merge that makes the chosen order safe.
    let release: (v: unknown) => void = () => {};
    invokeMock.mockReturnValue(
      new Promise((res) => {
        release = res;
      }),
    );
    const started = startObservedAttentionListener();
    await vi.waitFor(() => expect(handlers.length).toBe(1));

    emit(payload("a1", "awaiting")); // the live change, mid-round-trip
    release([payload("a1", "calm")]); // the older snapshot answering
    await started;

    expect(stored().a1?.verdict).toBe("awaiting");
  });

  it("survives a seed that fails — every later change still lands", async () => {
    invokeMock.mockRejectedValue(new Error("no such command"));
    await startObservedAttentionListener();
    emit(payload("a1", "awaiting"));
    expect(stored().a1?.verdict).toBe("awaiting");
  });

  it("drops ONE unreadable payload without losing the others", async () => {
    // The measured incident AGENTS.md records: an all-or-nothing parser discards the whole payload
    // and falls back to "we did not look", silently and permanently.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await startObservedAttentionListener();

    emit(payload("a1", "awaiting"));
    emit({ agentId: "a2", verdict: "probably-fine", alternate: false, atMs: 1 });
    emit(payload("a3", "unreadable"));

    expect(stored().a1?.verdict).toBe("awaiting");
    expect(stored().a2).toBeUndefined();
    expect(stored().a3?.verdict).toBe("unreadable");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("warns ONCE, not once per tick", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await startObservedAttentionListener();
    for (let i = 0; i < 5; i++) emit({ nonsense: true });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("DELETES a held verdict on the producer's `gone` retraction", async () => {
    // The defect this closes: emit-on-change means a swept agent's last verdict is the last thing
    // the consumer ever hears, so a spun-down agent that was `awaiting` stays raised forever.
    await startObservedAttentionListener();
    emit(payload("a1", "awaiting"));
    expect(stored().a1?.verdict).toBe("awaiting"); // non-vacuity: there is something to retract

    emit(payload("a1", "gone"));

    expect(stored().a1).toBeUndefined();
  });

  it("never STORES `gone` as if it were a reading", async () => {
    // The paired case. "The row is gone" would also pass if `gone` were stored under some other
    // key, or if the delete happened to clear the whole map.
    await startObservedAttentionListener();
    emit(payload("a1", "awaiting"));
    emit(payload("a2", "calm"));
    emit(payload("a2", "gone"));
    expect(stored().a2).toBeUndefined();
    expect(stored().a1?.verdict).toBe("awaiting");
  });

  it("a retraction taken DURING the seed round-trip is not resurrected by it", async () => {
    // The race: the snapshot is taken while `a1` is still live, the tick then sweeps `a1` and emits
    // `gone`, the listener clears it — and the older snapshot lands afterwards. Because a retraction
    // is an ABSENCE, the `{ ...seed, ...live }` spread cannot express it, so `a1` came back. The
    // producer has already dropped it, so no second `gone` ever arrives: the row would sit red
    // against a terminal that no longer exists, permanently.
    let release: (v: unknown) => void = () => {};
    invokeMock.mockReturnValue(
      new Promise((res) => {
        release = res;
      }),
    );
    const started = startObservedAttentionListener();
    await vi.waitFor(() => expect(handlers.length).toBe(1));

    emit(payload("a1", "gone")); // swept mid-round-trip
    release([payload("a1", "awaiting")]); // the older snapshot, still holding a1
    await started;

    expect(stored().a1).toBeUndefined();
  });

  it("THE PAIRED CASE — an agent NOT retracted is still seeded from the snapshot", async () => {
    // Without this, "a1 is absent" would also pass for a seed that dropped everything.
    let release: (v: unknown) => void = () => {};
    invokeMock.mockReturnValue(
      new Promise((res) => {
        release = res;
      }),
    );
    const started = startObservedAttentionListener();
    await vi.waitFor(() => expect(handlers.length).toBe(1));

    emit(payload("a1", "gone"));
    release([payload("a1", "awaiting"), payload("a2", "awaiting")]);
    await started;

    expect(stored().a1).toBeUndefined();
    expect(stored().a2?.verdict).toBe("awaiting");
  });

  it("arms exactly one listener across repeated starts (StrictMode / HMR)", async () => {
    await startObservedAttentionListener();
    await startObservedAttentionListener();
    expect(handlers.length).toBe(1);
  });

  it("actually detaches on teardown", async () => {
    const stop = await startObservedAttentionListener();
    expect(handlers.length).toBe(1);
    stop();
    await vi.waitFor(() => expect(handlers.length).toBe(0));
    expect(unlistenSpy).toHaveBeenCalled();

    // …and the store stops receiving. Asserts the SIDE EFFECT of the teardown, not that a spy ran.
    emit(payload("zz", "awaiting"));
    expect(stored().zz).toBeUndefined();
  });
});
