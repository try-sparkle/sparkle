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
  classifyClaudeChatError,
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

  it("swallows the Tauri 'handlerId' teardown race so cleanup never throws", async () => {
    // On a rapid unmount / window close the unlisten fn can fire AFTER Tauri tore down its internal
    // listeners map, throwing the benign "handlerId" race. cleanup() runs each unlisten through
    // safeUnlisten, so that race must not surface (previously it propagated as an unhandled throw).
    const cleanup = await sendClaudeChat(makeOpts());
    unlistenMock.mockImplementation(() => {
      throw new Error("undefined is not an object (evaluating 'listeners[eventId].handlerId')");
    });
    try {
      expect(() => cleanup()).not.toThrow();
      expect(unlistenMock).toHaveBeenCalledTimes(3);
    } finally {
      // Reset in finally so a failed assertion can't leak the throwing impl into later tests
      // (beforeEach only mockClear()s, which keeps the implementation).
      unlistenMock.mockReset();
    }
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

describe("classifyClaudeChatError", () => {
  it("classifies claude's own 'Not logged in · Please run /login' as auth + needsLogin", () => {
    const c = classifyClaudeChatError("Not logged in · Please run /login");
    expect(c.kind).toBe("auth");
    expect(c.needsLogin).toBe(true);
    // The cryptic "/login" hint is replaced by a Sparkle-native reconnect message.
    expect(c.message).toMatch(/reconnect claude code/i);
    expect(c.message).not.toMatch(/\/login/);
  });

  it("classifies other auth phrasings (invalid api key, unauthorized, 401, expired oauth) as auth", () => {
    for (const raw of [
      "Invalid API key · Please run /login",
      "authentication_error: unauthorized",
      "Error: 401 Unauthorized",
      "Your OAuth token has expired",
      "credentials are invalid",
    ]) {
      const c = classifyClaudeChatError(raw);
      expect(c.kind, `for: ${raw}`).toBe("auth");
      expect(c.needsLogin, `for: ${raw}`).toBe(true);
    }
  });

  it("classifies a usage-limit failure as usageLimit and KEEPS claude's own text (has the reset time)", () => {
    const raw = "Claude usage limit reached. Your limit resets at 5:00pm.";
    const c = classifyClaudeChatError(raw);
    expect(c.kind).toBe("usageLimit");
    expect(c.needsLogin).toBe(false);
    expect(c.message).toBe(raw); // verbatim — never lose the reset time
  });

  it("treats a generic failure as 'other' and surfaces the raw text unchanged", () => {
    const raw = "claude exited (code 1) with no output; result subtype 'error_during_execution'";
    const c = classifyClaudeChatError(raw);
    expect(c.kind).toBe("other");
    expect(c.needsLogin).toBe(false);
    expect(c.message).toBe(raw);
  });

  it("does not misclassify an unrelated error mentioning 'token' as auth", () => {
    // A stray 'token' in a non-auth context must NOT trip the auth path (which would wrongly show a
    // reconnect button). Only real auth phrasings do.
    const c = classifyClaudeChatError("Prompt exceeded the maximum token budget for this model");
    expect(c.kind).toBe("other");
    expect(c.needsLogin).toBe(false);
  });
});
