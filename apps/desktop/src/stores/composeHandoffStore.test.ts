import { describe, it, expect, beforeEach, vi } from "vitest";
import { useComposeHandoffStore, type ComposeHandoff } from "./composeHandoffStore";
// The LOGGER, not `console`: logger.ts binds its `realConsole` at module load, so a console spy
// installed later never sees the line and the row would pass vacuously against silent code — the
// exact failure being tested for.
import { log } from "../logger";

const store = () => useComposeHandoffStore.getState();

const handoff = (over: Partial<ComposeHandoff> = {}): ComposeHandoff => ({
  origin: "capture-build",
  projectId: "p1",
  text: "fix the header",
  attachments: [{ path: "/tmp/shot.png", dataUrl: "data:image/png;base64,AAAA" }],
  ...over,
});

beforeEach(() => useComposeHandoffStore.setState({ handoff: null }));

describe("composeHandoffStore", () => {
  it("starts empty", () => {
    expect(store().handoff).toBeNull();
  });

  it("set → take round-trips the draft intact", () => {
    const h = handoff();
    store().set(h);
    expect(store().handoff).toEqual(h);
    expect(store().take()).toEqual(h);
  });

  // THE IDEMPOTENCY GUARD, and the reason `take` is the only reader. A StrictMode double-mount or
  // an HMR replay runs the consuming effect twice; the second run must get nothing rather than
  // paste the narration twice and stage the screenshot twice.
  it("take() CLEARS — a second read gets null, never a double-apply", () => {
    store().set(handoff());
    expect(store().take()).not.toBeNull();
    expect(store().take()).toBeNull();
    expect(store().handoff).toBeNull();
  });

  it("take() on an empty store is a quiet null, not a throw", () => {
    expect(store().take()).toBeNull();
  });

  // A second capture before the first is consumed is the user sending a NEWER thought. Queuing
  // both would paste two narrations into one box; keeping the older would prefill the box with a
  // screenshot the user has already moved on from.
  it("a second set REPLACES an unconsumed draft", () => {
    store().set(handoff({ text: "first" }));
    store().set(handoff({ text: "second" }));
    expect(store().take()?.text).toBe("second");
    expect(store().take()).toBeNull();
  });

  // …AND SAYS SO. Replacing an unconsumed handoff throws away a whole capture — narration and
  // screenshot both — and it is the last path in this flow that could lose user work silently.
  // `dispatchBuild` has already logged "handed off" for the draft being dropped, so with no line
  // here the log positively ASSERTS a delivery that never happened, which is worse than silence
  // (roborev 53836). Reachable whenever the consuming effect hasn't run: two sends while the
  // owning window is still hidden, before focusThisWindow().
  it("logs a WARNING naming the draft it discarded", () => {
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    store().set(handoff({ text: "first", origin: "capture-build" }));
    store().set(handoff({ text: "second", origin: "capture-chat" }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toMatch(/replaced before it was ever delivered/i);
    // The dropped draft is identified by KIND/COUNT. `toEqual`, not `toMatchObject`: the redaction
    // below is only as good as this being the WHOLE payload, and toMatchObject passes with
    // arbitrary extra keys — so a future `droppedText`/`droppedPaths` could be added without a
    // single row going red (roborev 53851). An added field has to be declared here.
    expect(spy.mock.calls[0]![2]).toEqual({
      droppedOrigin: "capture-build",
      droppedProjectId: "p1",
      droppedChars: "first".length,
      droppedAttachments: 1,
      replacedByOrigin: "capture-chat",
    });
    // Never the text or the temp path — this log ships with support tickets. Asserted over the
    // SERIALIZED call, not a joined array: `[...].join(" ")` renders the payload object as
    // "[object Object]", so the structured half — the natural place such a leak would appear — went
    // entirely uninspected while the comment claimed it was covered.
    const serialized = JSON.stringify(spy.mock.calls[0]);
    expect(serialized).not.toContain("first");
    expect(serialized).not.toContain("/tmp/shot.png");
    spy.mockRestore();
  });

  it("does NOT warn on the ordinary path — a set into an empty store is not a loss", () => {
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    store().set(handoff());
    store().take();
    store().set(handoff({ text: "a later, separately consumed capture" }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("clear() drops an unconsumed draft without delivering it", () => {
    store().set(handoff());
    store().clear();
    expect(store().take()).toBeNull();
  });

  it("carries the capture-chat shape: a sparkle route and no agent", () => {
    store().set(handoff({ origin: "capture-chat", route: "sparkle", agentId: undefined }));
    const taken = store().take();
    expect(taken?.origin).toBe("capture-chat");
    expect(taken?.route).toBe("sparkle");
    expect(taken?.agentId).toBeUndefined();
  });

  // ══ THE WARNING NAMES NO PRODUCER ═════════════════════════════════════════════════════════════
  // It used to read "a capture handoff was replaced". `bead-chat` — the bead card's Chat button
  // (bead sparkle-1cpomd) — is the first origin that is not a capture, and a message hard-coding
  // one producer misattributes every other one's loss to a window the user never opened. The
  // dropped surface is already named, structurally, in `droppedOrigin`.
  it("names no producer in the replacement warning — the origin field does that", () => {
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    store().set(handoff({ origin: "bead-chat", text: "RE: @A bead ", attachments: [] }));
    store().set(handoff({ origin: "capture-build" }));
    expect(spy).toHaveBeenCalledTimes(1);
    const message = spy.mock.calls[0]![1] as string;
    expect(message).toMatch(/replaced before it was ever delivered/i);
    expect(message).not.toMatch(/capture/i);
    // The producer is still recoverable — from the field, which is true for every origin.
    expect(spy.mock.calls[0]![2]).toEqual({
      droppedOrigin: "bead-chat",
      droppedProjectId: "p1",
      droppedChars: "RE: @A bead ".length,
      droppedAttachments: 0,
      replacedByOrigin: "capture-build",
    });
    spy.mockRestore();
  });

  // The bead card's Chat draft: sparkle-routed like capture-chat, but with no attachments and no
  // agent. Its shape is what `services/beadChat.ts` writes, asserted there against the real call;
  // this row is only that the STORE can carry it.
  it("carries the bead-chat shape: sparkle route, no attachments, no agent", () => {
    store().set(handoff({ origin: "bead-chat", route: "sparkle", attachments: [], agentId: undefined }));
    const taken = store().take();
    expect(taken?.origin).toBe("bead-chat");
    expect(taken?.route).toBe("sparkle");
    expect(taken?.attachments).toEqual([]);
    expect(taken?.agentId).toBeUndefined();
  });

  it("an attachment-only handoff is representable — an image alone is a message", () => {
    store().set(handoff({ text: "" }));
    const taken = store().take();
    expect(taken?.text).toBe("");
    expect(taken?.attachments).toHaveLength(1);
  });
});
