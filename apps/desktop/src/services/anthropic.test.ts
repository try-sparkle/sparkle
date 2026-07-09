// @vitest-environment jsdom
// apps/desktop/src/services/anthropic.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { chatOnce, structuredJson, extractJson } from "./anthropic";
import { OutOfCreditsError } from "./credits";
import { useAuthStore } from "../stores/authStore";

/** chatOnce/structuredJson now enforce a hard local credit gate, so the network-path tests need a
 *  funded, signed-in account or the gate throws before invoke is ever reached. */
const fund = (balanceCents: number) =>
  useAuthStore.setState({
    me: { clerkUserId: "u", entitled: true, balanceCents, tokenVersion: 1 },
    tokenPresent: true,
    loading: false,
  });

beforeEach(() => {
  fund(500);
});

afterEach(() => {
  invokeMock.mockReset();
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false });
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

  it("maps the server's typed insufficient_credits error to OutOfCreditsError with the balance", async () => {
    // The Rust proxy returns `insufficient_credits:<balanceCents>` when the /ai/anthropic gate 402s.
    invokeMock.mockRejectedValue("insufficient_credits:1234");
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(OutOfCreditsError);
    expect((err as OutOfCreditsError).balanceCents).toBe(1234);
  });

  it("defaults the balance to 0 when the credits error carries no amount", async () => {
    invokeMock.mockRejectedValue("insufficient_credits");
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(OutOfCreditsError);
    expect((err as OutOfCreditsError).balanceCents).toBe(0);
  });

  it("forwards an optional purpose into the invoke body (metering-only)", async () => {
    invokeMock.mockResolvedValue("ok");
    await chatOnce("sys", "usr", 256, "Renamed agent to 'Fix OAuth loop'");
    expect(invokeMock).toHaveBeenCalledWith("anthropic_chat", {
      system: "sys",
      user: "usr",
      maxTokens: 256,
      purpose: "Renamed agent to 'Fix OAuth loop'",
    });
  });

  it("omits purpose from the invoke body when none is passed (byte-identical legacy shape)", async () => {
    invokeMock.mockResolvedValue("ok");
    await chatOnce("sys", "usr", 256);
    const [, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect("purpose" in args).toBe(false);
  });
});

describe("hard credit gate (fail fast, no network)", () => {
  it("chatOnce throws OutOfCreditsError with the live balance and never calls invoke at zero credits", async () => {
    fund(0);
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(OutOfCreditsError);
    expect((err as OutOfCreditsError).balanceCents).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("chatOnce throws OutOfCreditsError when signed out (no me)", async () => {
    useAuthStore.setState({ me: null, tokenPresent: false, loading: false });
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(OutOfCreditsError);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("structuredJson throws OutOfCreditsError before building the prompt at zero credits", async () => {
    fund(0);
    const err = await structuredJson("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(OutOfCreditsError);
    expect(invokeMock).not.toHaveBeenCalled();
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

  it("threads an optional purpose through to the invoke body", async () => {
    invokeMock.mockResolvedValue('{"ok":true}');
    await structuredJson("base", "usr", 2048, "Decomposed epic 'Billing'");
    const [, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.purpose).toBe("Decomposed epic 'Billing'");
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
