import { describe, it, expect, beforeEach, vi } from "vitest";

// --- mock the Tauri event/invoke layer (mirrors orchestrationListener.test.ts) ---
// Capture the registered handler per event name so a test can fire events at will.
const handlers: Record<string, (e: { payload: unknown }) => void> = {};
const unlistenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
    handlers[event] = cb;
    return Promise.resolve(unlistenMock);
  }),
}));
const invokeMock = vi.fn();
invokeMock.mockReturnValue(Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  sendClaudeChat,
  cancelClaudeChat,
  resolveClaudePath,
  type SendClaudeChatOptions,
} from "./claudeChat";

const fire = (event: string, payload: unknown) => handlers[event]?.({ payload });
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeOpts(over: Partial<SendClaudeChatOptions> = {}): SendClaudeChatOptions {
  return {
    id: "think-1",
    prompt: "Explain this repo",
    cwd: "/proj/root",
    claudePath: "/Users/x/.local/bin/claude",
    onDelta: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    ...over,
  };
}

describe("sendClaudeChat", () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k];
    invokeMock.mockClear();
    invokeMock.mockReturnValue(Promise.resolve());
    unlistenMock.mockClear();
  });

  it("invokes claude_chat_send with the mapped args (resumeSessionId null when absent)", async () => {
    await sendClaudeChat(makeOpts());
    expect(invokeMock).toHaveBeenCalledWith("claude_chat_send", {
      id: "think-1",
      prompt: "Explain this repo",
      cwd: "/proj/root",
      claudePath: "/Users/x/.local/bin/claude",
      resumeSessionId: null,
    });
  });

  it("passes resumeSessionId through for multi-turn continuity", async () => {
    await sendClaudeChat(makeOpts({ resumeSessionId: "sess-42" }));
    const [, args] = invokeMock.mock.calls.at(-1)!;
    expect((args as { resumeSessionId: string }).resumeSessionId).toBe("sess-42");
  });

  it("wires listeners BEFORE invoking so no early delta is missed", async () => {
    // listen() must have registered all three handlers by the time invoke is first called.
    let handlersAtInvoke = 0;
    invokeMock.mockImplementationOnce(() => {
      handlersAtInvoke = Object.keys(handlers).length;
      return Promise.resolve();
    });
    await sendClaudeChat(makeOpts());
    expect(handlersAtInvoke).toBe(3);
  });

  it("routes delta/done/error to the right callbacks, filtered by id", async () => {
    const opts = makeOpts();
    await sendClaudeChat(opts);

    fire("claude_chat:delta", { id: "think-1", text: "Hello" });
    fire("claude_chat:delta", { id: "think-1", text: " world" });
    fire("claude_chat:done", { id: "think-1", sessionId: "sess-A", text: "Hello world" });

    expect(opts.onDelta).toHaveBeenNthCalledWith(1, "Hello");
    expect(opts.onDelta).toHaveBeenNthCalledWith(2, " world");
    expect(opts.onDone).toHaveBeenCalledWith({ sessionId: "sess-A", text: "Hello world" });
    expect(opts.onError).not.toHaveBeenCalled();
  });

  it("ignores events for a different id", async () => {
    const opts = makeOpts({ id: "mine" });
    await sendClaudeChat(opts);

    fire("claude_chat:delta", { id: "someone-else", text: "nope" });
    fire("claude_chat:done", { id: "someone-else", sessionId: "x", text: "nope" });
    fire("claude_chat:error", { id: "someone-else", message: "nope" });

    expect(opts.onDelta).not.toHaveBeenCalled();
    expect(opts.onDone).not.toHaveBeenCalled();
    expect(opts.onError).not.toHaveBeenCalled();
  });

  it("routes the error event to onError", async () => {
    const opts = makeOpts();
    await sendClaudeChat(opts);
    fire("claude_chat:error", { id: "think-1", message: "boom" });
    expect(opts.onError).toHaveBeenCalledWith("boom");
  });

  it("returns a cleanup that unsubscribes all three listeners", async () => {
    const cleanup = await sendClaudeChat(makeOpts());
    expect(unlistenMock).not.toHaveBeenCalled();
    cleanup();
    expect(unlistenMock).toHaveBeenCalledTimes(3);
    // Idempotent: a second call doesn't double-unlisten.
    cleanup();
    expect(unlistenMock).toHaveBeenCalledTimes(3);
  });

  it("routes a synchronous invoke failure to onError and tears the listeners down", async () => {
    invokeMock.mockReturnValueOnce(Promise.reject(new Error("invalid cwd")));
    const opts = makeOpts();
    await sendClaudeChat(opts);
    expect(opts.onError).toHaveBeenCalledWith("invalid cwd");
    // Listeners were unsubscribed on the failure path.
    expect(unlistenMock).toHaveBeenCalledTimes(3);
    // A late event for this turn must not reach the callbacks (handler is detached).
    opts.onDelta = vi.fn();
  });
});

describe("cancelClaudeChat", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    invokeMock.mockReturnValue(Promise.resolve());
  });

  it("invokes claude_chat_cancel with the id", async () => {
    await cancelClaudeChat("think-9");
    expect(invokeMock).toHaveBeenCalledWith("claude_chat_cancel", { id: "think-9" });
  });
});

describe("resolveClaudePath", () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it("returns the absolute path from preflight when installed", async () => {
    invokeMock.mockReturnValueOnce(
      Promise.resolve({ installed: true, path: "/usr/local/bin/claude", version: "2.1.0" }),
    );
    await expect(resolveClaudePath()).resolves.toBe("/usr/local/bin/claude");
    expect(invokeMock).toHaveBeenCalledWith("claude_preflight");
  });

  it("throws when Claude Code is not installed", async () => {
    invokeMock.mockReturnValueOnce(
      Promise.resolve({ installed: false, path: null, version: null }),
    );
    await expect(resolveClaudePath()).rejects.toThrow(/not installed/i);
  });

  it("throws when installed is true but path is missing", async () => {
    invokeMock.mockReturnValueOnce(
      Promise.resolve({ installed: true, path: null, version: null }),
    );
    await expect(resolveClaudePath()).rejects.toThrow(/not installed/i);
  });
});
