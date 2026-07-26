// @vitest-environment jsdom
// apps/desktop/src/services/anthropic.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  chatOnce,
  structuredJson,
  extractJson,
  AiUnavailableError,
  AiUnreachableError,
} from "./anthropic";
import { OutOfCreditsError } from "./credits";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";

/** chatOnce/structuredJson now enforce a hard local credit gate, so the network-path tests need a
 *  funded, signed-in account or the gate throws before invoke is ever reached. */
const fund = (balanceCents: number) =>
  useAuthStore.setState({
    me: { clerkUserId: "u", entitled: true, balanceCents, tokenVersion: 1 },
    tokenPresent: true,
    loading: false,
  });

/** Zustand's `setState` MERGES, so anything a test overwrites — a data field OR a stubbed action —
 *  leaks into the rest of the file unless it is put back. Snapshotting the WHOLE initial state and
 *  restoring it wholesale in `afterEach` makes that general: it covers actions nobody has stubbed
 *  yet and fields nobody has enumerated, so no future test has to remember to extend a list.
 *  The REPLACE form (second arg `true`), so a key a future test introduces cannot survive teardown
 *  either — with a merge, "wholesale" would only have covered keys that already existed. */
const initialState = useAuthStore.getState();

beforeEach(() => {
  fund(500);
  useAuthStore.setState({ creditFloorCents: 0 });
});

afterEach(() => {
  invokeMock.mockReset();
  useAuthStore.setState(initialState, true);
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

  it("decodes the ai_unreachable sentinel and marks the connection store offline", async () => {
    useConnectionStore.setState({ browserOnline: true, probeOk: true, isOnline: true });
    invokeMock.mockRejectedValue("ai_unreachable");
    await expect(chatOnce("sys", "usr")).rejects.toBeInstanceOf(AiUnreachableError);
    // The real request is fresher evidence than the 30s heartbeat, so it drives the store directly.
    expect(useConnectionStore.getState().isOnline).toBe(false);
  });

  it("leaves the connection store alone for a non-connectivity failure", async () => {
    useConnectionStore.setState({ browserOnline: true, probeOk: true, isOnline: true });
    invokeMock.mockRejectedValue("ai request failed");
    await expect(chatOnce("sys", "usr")).rejects.toThrow("Claude request failed: ai request failed");
    // A misconfiguration or server-side fault must NOT be reported to the user as being offline.
    expect(useConnectionStore.getState().isOnline).toBe(true);
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

  // An amount-less refusal reports the balance we already hold rather than a fabricated 0.
  // Contract only — see the `OutOfCreditsError.balanceCents` doc.
  // 250, not the `beforeEach` default of 500 — otherwise the assertion could pass on the default
  // instead of on the held balance actually being read.
  it("reports the held balance when the credits error carries no amount", async () => {
    fund(250);
    invokeMock.mockRejectedValue("insufficient_credits");
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(OutOfCreditsError);
    expect((err as OutOfCreditsError).balanceCents).toBe(250);
  });

  // Pins the READ ORDER, which the hoist alone does not: against today's store both orderings give
  // the same answer, so a refactor moving the read back below the mutation would pass everything.
  // Overriding the action to wipe `me` makes the two orderings differ — post-mutation would report
  // 0. Fails if the read moves.
  it("reports the balance held BEFORE the store mutation, not after", async () => {
    fund(250);
    // The stub is undone by `afterEach` (see `initialState`), not by a local finally.
    useAuthStore.setState({
      noteCreditsRefused: () => useAuthStore.setState({ me: null, creditFloorCents: 0 }),
    });
    invokeMock.mockRejectedValue("insufficient_credits");
    const err = await chatOnce("sys", "usr").catch((e) => e);
    // Type asserted first, like every sibling case: without it, a refactor throwing a plain Error
    // would fail as "expected undefined to be 250" and read as a read-order regression.
    expect(err).toBeInstanceOf(OutOfCreditsError);
    expect((err as OutOfCreditsError).balanceCents).toBe(250);
  });

  // Pins the CONTRACT for the `?? 0` arm, not a live path: `held` is read only when `reported` is
  // null (see its doc in authStore.ts). Given that, a sign-out mid-request leaves no balance to report.
  it("falls back to 0 when a sign-out nulls `me` during an amount-less refusal", async () => {
    fund(250);
    // Seeded non-zero so the floor assertion below is not vacuous: `beforeEach` zeroes the floor,
    // so expecting 0 against an untouched store would pass even if the refusal never wrote it.
    useAuthStore.setState({ creditFloorCents: 99 });
    invokeMock.mockImplementation(() => {
      useAuthStore.setState({ me: null, tokenPresent: false });
      return Promise.reject("insufficient_credits");
    });
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(OutOfCreditsError);
    expect((err as OutOfCreditsError).balanceCents).toBe(0);
    expect(useAuthStore.getState().me).toBeNull(); // no identity conjured by the refusal
    // The consequential half: a signed-out race must leave no floor behind for the next session's
    // `me` to be gated against — so the seeded 99 must be overwritten, not preserved.
    expect(useAuthStore.getState().creditFloorCents).toBe(0);
  });

  // Regression: the 402 used to be mapped and thrown, and the balance it carried thrown away with
  // it. A leftover positive balance kept satisfying the local `balance > 0` gate, so every AI
  // surface re-issued the same guaranteed-402 call — the refusal never taught the client anything.
  it("records the server's refusal so the local credit gate closes at that balance", async () => {
    fund(1); // enough for the client gate, not enough for the server's reservation
    invokeMock.mockRejectedValue("insufficient_credits:1");
    await chatOnce("sys", "usr").catch(() => {});
    expect(useAuthStore.getState().creditFloorCents).toBe(1);
    expect(useAuthStore.getState().me?.balanceCents).toBe(1);

    // The gate is now closed, so the NEXT call fails locally without another doomed round-trip.
    invokeMock.mockReset();
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(OutOfCreditsError);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("adopts the server's balance figure over the client's stale one", async () => {
    fund(500); // stale local view
    invokeMock.mockRejectedValue("insufficient_credits:3");
    await chatOnce("sys", "usr").catch(() => {});
    expect(useAuthStore.getState().me?.balanceCents).toBe(3);
  });

  // Pins the contract for the suffix-less sentinel, which the real caller cannot produce today —
  // see the `noteCreditsRefused` doc in authStore.ts (sparkle-q5re).
  it("a suffix-less refusal does NOT zero a known balance", async () => {
    fund(400);
    invokeMock.mockRejectedValue("insufficient_credits");
    await chatOnce("sys", "usr").catch(() => {});
    expect(useAuthStore.getState().me?.balanceCents).toBe(400);
    expect(useAuthStore.getState().creditFloorCents).toBe(400); // falls back to the held balance
  });

  // CHARACTERIZATION of today's REACHABLE behavior, and it is the buggy one. An unparseable 402
  // body reaches us as `insufficient_credits:0`, so the fabricated 0 IS adopted as the balance and
  // the floor lands at 0 — which does not even close the gate (`hasAiCredits` needs balance > floor,
  // and 0 > 0 is false, so the surface goes dark via the zero balance rather than via the floor).
  // Asserted, not fixed, because the fix belongs in the Rust classifier: bead sparkle-q5re must
  // make this test change, rather than silently altering an untested path.
  it("adopts the fabricated 0 from an unparseable 402 body (sparkle-q5re)", async () => {
    fund(400);
    invokeMock.mockRejectedValue("insufficient_credits:0");
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(useAuthStore.getState().me?.balanceCents).toBe(0); // the funded 400 is lost
    expect(useAuthStore.getState().creditFloorCents).toBe(0);
    // The THROWN figure is fabricated too. `reported` is 0, not null, so `?? held` never fires and
    // the sibling test's held-balance protection does NOT cover this path. Asserted so the two
    // adjacent tests can't be read as "the thrown balance is safe everywhere". Flips with the bead.
    expect(err).toBeInstanceOf(OutOfCreditsError);
    expect((err as OutOfCreditsError).balanceCents).toBe(0);
  });

  it("leaves the floor alone for a non-credits failure", async () => {
    invokeMock.mockRejectedValue("ai_unconfigured");
    await chatOnce("sys", "usr").catch(() => {});
    expect(useAuthStore.getState().creditFloorCents).toBe(0);
  });

  it("maps the server's typed ai_unconfigured error to AiUnavailableError", async () => {
    // The Rust proxy returns `ai_unconfigured` when /ai/anthropic 503s (no vendor key) or 404s
    // (route absent). Callers branch on the class to defer instead of retrying a doomed call.
    invokeMock.mockRejectedValue("ai_unconfigured");
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
  });

  it("leaves a generic proxy failure as a plain wrapped Error", async () => {
    // Only the exact sentinel is special-cased — a transient gateway failure must stay retryable.
    invokeMock.mockRejectedValue("ai request failed (HTTP 502)");
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).not.toBeInstanceOf(AiUnavailableError);
    expect((err as Error).message).toBe("Claude request failed: ai request failed (HTTP 502)");
  });

  it("forwards the optional purpose + project into the invoke body (metering-only)", async () => {
    invokeMock.mockResolvedValue("ok");
    await chatOnce("sys", "usr", 256, {
      purpose: "Renamed agent to 'Fix OAuth loop'",
      project: "sparkle-desktop",
    });
    expect(invokeMock).toHaveBeenCalledWith("anthropic_chat", {
      system: "sys",
      user: "usr",
      maxTokens: 256,
      purpose: "Renamed agent to 'Fix OAuth loop'",
      project: "sparkle-desktop",
    });
  });

  it("omits project when only a purpose is known — no empty-string stand-in", async () => {
    // A row with no attributable project must carry NO project key, so the history can say
    // "we didn't record one" instead of showing a blank that looks like a real project name.
    invokeMock.mockResolvedValue("ok");
    await chatOnce("sys", "usr", 256, { purpose: "Naming an agent" });
    const [, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.purpose).toBe("Naming an agent");
    expect(args).not.toHaveProperty("project");
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

  // The reply is COMPLETE and valid; the model just kept talking afterwards. Taking the last `]` in
  // the text swallowed that sentence into the slice, so a usable answer parsed as an error and was
  // retried at full price. Observed in the wild from the suggestion engine.
  it("stops at the document's own close, not a bracket in trailing prose", () => {
    const reply = '[{"label":"Push","value":"Push the branch."}]\n\nI ranked push first [see recent commits].';
    expect(JSON.parse(extractJson(reply))).toEqual([{ label: "Push", value: "Push the branch." }]);
  });

  it("ignores delimiters inside strings", () => {
    expect(JSON.parse(extractJson('{"a":"a ] and a } in a value"}'))).toEqual({
      a: "a ] and a } in a value",
    });
    expect(JSON.parse(extractJson('{"a":"trailing backslash \\\\"}'))).toEqual({
      a: "trailing backslash \\",
    });
  });

  it("keeps nested structures intact", () => {
    expect(JSON.parse(extractJson('prose {"a":[1,{"b":[2]}],"c":3} more'))).toEqual({
      a: [1, { b: [2] }],
      c: 3,
    });
  });

  it("returns the first complete document when the model emits two", () => {
    expect(extractJson('[1,2] and then [3,4]')).toBe("[1,2]");
  });

  // A truncated reply can't parse either way — but the slice must not end at some earlier nested
  // close, which left an object open and produced a misleading "Expected '}'".
  it("returns the document from its start when it is never closed", () => {
    const truncated = 'Here you go: [{"label":"A","value":"x","tags":["ci","pr"]},{"label":"B","valu';
    expect(extractJson(truncated)).toBe('[{"label":"A","value":"x","tags":["ci","pr"]},{"label":"B","valu');
    expect(() => JSON.parse(extractJson(truncated))).toThrow();
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

  it("threads the optional purpose + project through to the invoke body", async () => {
    invokeMock.mockResolvedValue('{"ok":true}');
    await structuredJson("base", "usr", 2048, {
      purpose: "Decomposed epic 'Billing'",
      project: "acme",
    });
    const [, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.purpose).toBe("Decomposed epic 'Billing'");
    expect(args.project).toBe("acme");
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
