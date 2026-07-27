// The concierge service's contract with U1/U7 (bead sparkle-ma6e): startConciergeTurn invokes
// `concierge_turn` with the prompt + resume id, the sessionId from each `concierge:done` is
// captured and auto-passed as the resume target on the NEXT turn (one ongoing conversation),
// subscriptions fan out with synchronous unsubscribe, and NOTHING here throws to callers — a
// rejected invoke surfaces as a synthetic error event. Tauri invoke/listen are mocked with the
// same name-keyed harness improvementPass.watchdog.test.ts uses.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (ev: { payload: unknown }) => void;
const harness = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  invokes: [] as Array<{ cmd: string; args: unknown }>,
  // Per-test overrides keyed by COMMAND/EVENT NAME; return undefined to use the default.
  // concierge_turn resolves with the turn's id now, so this is `unknown`, not `void`.
  invokeImpl: undefined as ((cmd: string) => Promise<unknown> | undefined) | undefined,
  listenImpl: undefined as ((name: string) => Promise<() => void> | undefined) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: unknown) => {
    harness.invokes.push({ cmd, args });
    return harness.invokeImpl?.(cmd) ?? Promise.resolve();
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: Handler) => {
    const override = harness.listenImpl?.(name);
    if (override) return override;
    harness.handlers.set(name, handler);
    return Promise.resolve(() => harness.handlers.delete(name));
  }),
}));

import {
  _resetConciergeForTests,
  CONCIERGE_LOCAL_ERROR_ID,
  cancelConciergeTurn,
  getConciergeSessionId,
  onConciergeDelta,
  onConciergeDone,
  onConciergeError,
  resetConciergeSession,
  startConciergeTurn,
  SUPERSEDED_DETAILS,
} from "./concierge";

/** The args of the nth `concierge_turn` invoke (0-based). */
function turnArgs(n: number): { prompt: string; resumeSessionId: string | null } {
  const call = harness.invokes.filter((c) => c.cmd === "concierge_turn").at(n);
  if (!call) throw new Error(`expected a concierge_turn invoke #${n}`);
  return call.args as { prompt: string; resumeSessionId: string | null };
}

describe("concierge service", () => {
  beforeEach(() => {
    harness.handlers.clear();
    harness.invokes.length = 0;
    harness.invokeImpl = undefined;
    harness.listenImpl = undefined;
    _resetConciergeForTests();
  });

  it("returns the turn's id, so a caller can tell its events from a superseded turn's", async () => {
    // concierge.rs emits deltas unconditionally — only the reap is token-gated — so a killed turn
    // keeps flushing buffered stdout under its own id. Without the live token the UI can only
    // infer supersession from ids it happens to have seen (roborev 53051).
    harness.invokeImpl = (cmd) => (cmd === "concierge_turn" ? Promise.resolve("42") : undefined);
    await expect(startConciergeTurn("go")).resolves.toBe("42");
  });

  it("invokes concierge_turn with the prompt and a null resume on the first turn", async () => {
    await startConciergeTurn("snapshot: all quiet");
    expect(turnArgs(0)).toEqual({ prompt: "snapshot: all quiet", resumeSessionId: null });
    // The event listeners were wired before the invoke, so no early event can be missed.
    expect(harness.handlers.has("concierge:delta")).toBe(true);
    expect(harness.handlers.has("concierge:done")).toBe(true);
    expect(harness.handlers.has("concierge:error")).toBe(true);
  });

  it("captures the sessionId from done and auto-resumes it on the next turn", async () => {
    await startConciergeTurn("first");
    expect(turnArgs(0).resumeSessionId).toBeNull();

    harness.handlers.get("concierge:done")?.({
      payload: { id: "1", sessionId: "sess-A", text: "All quiet." },
    });
    expect(getConciergeSessionId()).toBe("sess-A");

    await startConciergeTurn("second");
    expect(turnArgs(1).resumeSessionId).toBe("sess-A");
  });

  it("an explicit resumeSessionId overrides the tracked one and becomes the new session", async () => {
    await startConciergeTurn("first");
    harness.handlers.get("concierge:done")?.({
      payload: { id: "1", sessionId: "sess-A", text: "hi" },
    });

    await startConciergeTurn("second", "sess-OVERRIDE");
    expect(turnArgs(1).resumeSessionId).toBe("sess-OVERRIDE");
    expect(getConciergeSessionId()).toBe("sess-OVERRIDE");
  });

  it("fans events out to subscribers and unsubscribe stops delivery", async () => {
    const deltas: string[] = [];
    const dones: string[] = [];
    const offDelta = onConciergeDelta((e) => deltas.push(e.text));
    const offDone = onConciergeDone((e) => dones.push(e.sessionId));
    await startConciergeTurn("go");

    harness.handlers.get("concierge:delta")?.({ payload: { id: "1", text: "Hello" } });
    harness.handlers.get("concierge:delta")?.({ payload: { id: "1", text: " world" } });
    harness.handlers.get("concierge:done")?.({
      payload: { id: "1", sessionId: "sess-B", text: "Hello world" },
    });
    expect(deltas).toEqual(["Hello", " world"]);
    expect(dones).toEqual(["sess-B"]);

    offDelta();
    offDone();
    harness.handlers.get("concierge:delta")?.({ payload: { id: "2", text: "late" } });
    expect(deltas).toEqual(["Hello", " world"]);
  });

  it("an error event reaches subscribers, throws nothing, and drops the session for a fresh next turn", async () => {
    const errors: string[] = [];
    onConciergeError((e) => errors.push(e.detail));
    await startConciergeTurn("first");
    harness.handlers.get("concierge:done")?.({
      payload: { id: "1", sessionId: "sess-A", text: "ok" },
    });

    harness.handlers.get("concierge:error")?.({
      payload: { id: "2", detail: "Claude usage limit reached" },
    });
    expect(errors).toEqual(["Claude usage limit reached"]);
    // The Rust side already retried the stale resume; a still-failed turn must not chain the
    // same session into the next turn.
    expect(getConciergeSessionId()).toBeNull();
    await startConciergeTurn("second");
    expect(turnArgs(1).resumeSessionId).toBeNull();
  });

  it.each(SUPERSEDED_DETAILS.map((d) => [d] as const))(
    "a send rejected with %s resolves null SILENTLY — no error bubble, no typing reset",
    async (detail) => {
      // Both are ordinary outcomes of two fast sends. Surfacing them would post "I couldn't reach
      // my brain just now" and clear the typing indicator for the turn that IS running: a local
      // error carries no turn id, so it bypasses supersededTurn entirely (roborev 53186). Driven
      // from the exported constant, not re-typed literals, so a reword fails here (roborev 53205).
      harness.invokeImpl = (cmd) =>
        cmd === "concierge_turn" ? Promise.reject(new Error(detail)) : undefined;
      const errors: Array<{ id: string; detail: string }> = [];
      onConciergeError((e) => errors.push(e));

      await expect(startConciergeTurn("go")).resolves.toBeNull();
      expect(errors).toEqual([]);
    },
  );

  it("a rejected invoke never throws — it surfaces as a synthetic local error event", async () => {
    harness.invokeImpl = (cmd) =>
      cmd === "concierge_turn" ? Promise.reject(new Error("claude binary not found")) : undefined;
    const errors: Array<{ id: string; detail: string }> = [];
    onConciergeError((e) => errors.push(e));

    // null, not a turn id: there is no turn to identify (roborev 53051). Callers key their
    // supersession bookkeeping on the returned id, so a rejected invoke must not hand back one.
    await expect(startConciergeTurn("go")).resolves.toBeNull();
    expect(errors).toEqual([
      { id: CONCIERGE_LOCAL_ERROR_ID, detail: "claude binary not found" },
    ]);
  });

  it("a throwing subscriber does not break fan-out to the others", async () => {
    const seen: string[] = [];
    onConciergeDelta(() => {
      throw new Error("bad subscriber");
    });
    onConciergeDelta((e) => seen.push(e.text));
    await startConciergeTurn("go");

    harness.handlers.get("concierge:delta")?.({ payload: { id: "1", text: "still delivered" } });
    expect(seen).toEqual(["still delivered"]);
  });

  it("cancelConciergeTurn invokes concierge_cancel and never rejects", async () => {
    await cancelConciergeTurn();
    expect(harness.invokes.some((c) => c.cmd === "concierge_cancel")).toBe(true);

    harness.invokeImpl = (cmd) =>
      cmd === "concierge_cancel" ? Promise.reject(new Error("boom")) : undefined;
    await expect(cancelConciergeTurn()).resolves.toBeUndefined();
  });

  it("resetConciergeSession forgets the session so the next turn starts fresh", async () => {
    await startConciergeTurn("first");
    harness.handlers.get("concierge:done")?.({
      payload: { id: "1", sessionId: "sess-A", text: "ok" },
    });
    resetConciergeSession();
    expect(getConciergeSessionId()).toBeNull();
    await startConciergeTurn("second");
    expect(turnArgs(1).resumeSessionId).toBeNull();
  });

  it("a failed listen registration never throws and reports through the local error surface", async () => {
    harness.listenImpl = (name) =>
      name === "concierge:error" ? Promise.reject(new Error("event bus unavailable")) : undefined;
    const errors: Array<{ id: string; detail: string }> = [];
    onConciergeError((e) => errors.push(e));

    // startConciergeTurn must not throw even when wiring fails; wiring is a precondition for a
    // turn (a turn whose stream nobody can hear is useless), so the invoke is withheld and the
    // failure is delivered to the LOCAL error fan-out (which needs no Tauri bus).
    // null, not a turn id: there is no turn to identify (roborev 53051). Callers key their
    // supersession bookkeeping on the returned id, so a rejected invoke must not hand back one.
    await expect(startConciergeTurn("go")).resolves.toBeNull();
    expect(harness.invokes.some((c) => c.cmd === "concierge_turn")).toBe(false);
    expect(errors).toEqual([
      { id: CONCIERGE_LOCAL_ERROR_ID, detail: "event bus unavailable" },
    ]);
  });

  it("recovers from a PARTIAL wiring failure without leaking duplicate listeners", async () => {
    let failWiring = true;
    // delta/done register successfully; only the error listener rejects — a partial failure.
    harness.listenImpl = (name) =>
      failWiring && name === "concierge:error" ? Promise.reject(new Error("bus down")) : undefined;
    await startConciergeTurn("first"); // wiring rejects → the turn is withheld
    expect(harness.invokes.some((c) => c.cmd === "concierge_turn")).toBe(false);
    // The two listeners that DID register were unlistened during cleanup — no survivors to stack.
    expect(harness.handlers.has("concierge:delta")).toBe(false);
    expect(harness.handlers.has("concierge:done")).toBe(false);
    // The bus recovers; the NEXT turn must re-attempt wiring (a rejected wiring promise is not cached).
    failWiring = false;
    await startConciergeTurn("second");
    expect(harness.invokes.some((c) => c.cmd === "concierge_turn")).toBe(true);
    expect(harness.handlers.has("concierge:error")).toBe(true);
  });

  it("does not advance the session id when the turn invoke fails", async () => {
    harness.invokeImpl = (cmd) =>
      cmd === "concierge_turn" ? Promise.reject(new Error("boom")) : undefined;
    // An explicit resume override + a failing invoke: the id must NOT be stored for a turn that never ran.
    await startConciergeTurn("hi", "explicit-sid");
    expect(getConciergeSessionId()).toBeNull();
  });
});
