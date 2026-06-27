// apps/desktop/src/services/anthropic.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { chatOnce, structuredJson, extractJson } from "./anthropic";

afterEach(() => {
  invokeMock.mockReset();
});

describe("chatOnce", () => {
  it("forwards camelCase args and returns the trimmed reply", async () => {
    invokeMock.mockResolvedValue("  hello world  \n");
    const out = await chatOnce("sys", "usr", 512);
    expect(out).toBe("hello world");
    expect(invokeMock).toHaveBeenCalledWith("anthropic_chat", {
      system: "sys",
      user: "usr",
      maxTokens: 512,
    });
  });

  it("defaults maxTokens to 1024", async () => {
    invokeMock.mockResolvedValue("ok");
    await chatOnce("sys", "usr");
    expect(invokeMock).toHaveBeenCalledWith("anthropic_chat", {
      system: "sys",
      user: "usr",
      maxTokens: 1024,
    });
  });

  it("wraps a thrown string error with a friendly prefix", async () => {
    invokeMock.mockRejectedValue("rate limited");
    await expect(chatOnce("sys", "usr")).rejects.toThrow("Claude request failed: rate limited");
  });

  it("propagates a thrown Error unchanged", async () => {
    invokeMock.mockRejectedValue(new Error("network down"));
    await expect(chatOnce("sys", "usr")).rejects.toThrow("network down");
  });
});

describe("extractJson", () => {
  it("returns clean JSON untouched", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it("strips ```json fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips bare ``` fences", () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("drops leading and trailing prose around an object", () => {
    expect(extractJson('Here you go:\n{"a":1}\nHope that helps!')).toBe('{"a":1}');
  });

  it("extracts an array document", () => {
    expect(extractJson('The list is [1,2,3] done')).toBe("[1,2,3]");
  });
});

describe("structuredJson", () => {
  it("appends a JSON-only instruction to the system prompt", async () => {
    invokeMock.mockResolvedValue('{"ok":true}');
    await structuredJson("base prompt", "usr");
    const [cmd, args] = invokeMock.mock.calls[0] as [string, { system: string; maxTokens: number }];
    expect(cmd).toBe("anthropic_chat");
    expect(args.system).toContain("base prompt");
    expect(args.system).toContain("ONLY valid");
    expect(args.maxTokens).toBe(2048);
  });

  it("parses a clean JSON reply", async () => {
    invokeMock.mockResolvedValue('{"name":"x","n":2}');
    const out = await structuredJson<{ name: string; n: number }>("sys", "usr");
    expect(out).toEqual({ name: "x", n: 2 });
  });

  it("parses a fenced ```json block", async () => {
    invokeMock.mockResolvedValue('```json\n{"name":"x"}\n```');
    const out = await structuredJson<{ name: string }>("sys", "usr");
    expect(out).toEqual({ name: "x" });
  });

  it("parses JSON preceded by prose", async () => {
    invokeMock.mockResolvedValue('Sure! Here is the result: {"name":"x"}');
    const out = await structuredJson<{ name: string }>("sys", "usr");
    expect(out).toEqual({ name: "x" });
  });

  it("throws a clear error on garbage, including the raw reply", async () => {
    invokeMock.mockResolvedValue("not json at all, sorry");
    await expect(structuredJson("sys", "usr")).rejects.toThrow(
      "Claude did not return valid JSON: not json at all, sorry"
    );
  });
});
