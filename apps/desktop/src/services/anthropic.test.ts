// @vitest-environment jsdom
// apps/desktop/src/services/anthropic.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  AiBusyError,
  AiTransientError,
  ClaudeAuthError,
  ClaudeMissingError,
  ClaudeUsageLimitError,
  chatOnce,
  noteAiProviderFailure,
  noteAiProviderHealthy,
  noteAiServiceFailure,
  noteAiServiceHealthy,
  structuredJson,
  extractJson,
  parseUnavailableReason,
  AiUnavailableError,
  AiUnreachableError,
} from "./anthropic";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useAiProviderStore } from "../stores/aiProviderStore";
import {
  AI_SERVICE_DEGRADED_THRESHOLD,
  HEALTHY_SERVICE,
  useAiServiceHealthStore,
} from "../stores/aiServiceHealthStore";

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

describe("parseUnavailableReason", () => {
  // REPOINTED with the transport. The reasons used to describe SPARKLE'S vendor account
  // (provider_unfunded / provider_key_rejected); neither can occur now that the account is retired
  // and the work runs on the user's own Claude Code subscription. What can occur is local to their
  // install — and unlike the old reasons, each of these has an action the user can take.
  it("distinguishes 'not this error' from a real outage sentinel", () => {
    expect(parseUnavailableReason("ai request failed (HTTP 502)")).toBeUndefined();
    expect(parseUnavailableReason("ai_busy")).toBeUndefined();
    expect(parseUnavailableReason("ai_timeout")).toBeUndefined();
  });

  it("reads the recognised reasons", () => {
    expect(parseUnavailableReason("ai_unconfigured")).toBe("cli_missing");
    expect(parseUnavailableReason("claude_not_authenticated")).toBe("cli_not_authenticated");
    expect(parseUnavailableReason("claude_usage_limit")).toBe("usage_limit");
  });
});

describe("noteAiProviderHealthy / noteAiProviderFailure", () => {
  // These exist because chatOnce is NOT the only proxied path: generate_agent_name,
  // judge_turn_followup and route_classify each own a Tauri command and a JS wrapper, all receiving
  // the same sentinel. Wiring only chatOnce meant a naming+routing session saw no banner, and — the
  // costly half — a successful naming/judge/route call could not CLEAR one, leaving a
  // non-dismissible banner claiming the provider was broken while it was healthy (roborev 54761).
  it("records an outage from any wrapper, not just chatOnce", () => {
    useAiProviderStore.setState({ outage: null });
    noteAiProviderFailure("claude_not_authenticated");
    expect(useAiProviderStore.getState().outage?.reason).toBe("cli_not_authenticated");
  });

  it("CLEARS an outage from a non-chatOnce success — the recovery path that was missing", () => {
    useAiProviderStore.setState({ outage: { reason: "cli_not_authenticated", at: 1 } });
    noteAiProviderHealthy();
    expect(useAiProviderStore.getState().outage).toBeNull();
  });

  it("ignores failures that say nothing about the provider", () => {
    useAiProviderStore.setState({ outage: null });
    // ai_busy/ai_timeout are LOCAL stalls, not outages — they must never light the banner.
    for (const e of ["ai request failed (HTTP 502)", "ai_busy", "ai_timeout"]) {
      noteAiProviderFailure(e);
    }
    noteAiProviderFailure(new Error("boom"));
    noteAiProviderFailure(undefined);
    expect(useAiProviderStore.getState().outage).toBeNull();
  });
});

describe("noteAiServiceHealthy / noteAiServiceFailure (the sustained-outage signal)", () => {
  // The SEV that this exists for was bare 502s, which the provider signal above never sees. And like
  // that signal, it must be fed from EVERY wrapper, not just chatOnce — so these test the wiring fns
  // the four wrappers call, plus chatOnce end-to-end.
  beforeEach(() => useAiServiceHealthStore.setState({ ...HEALTHY_SERVICE }));

  it("degrades after a SUSTAINED run of 502s from ANY wrapper, not just chatOnce", () => {
    for (let i = 0; i < AI_SERVICE_DEGRADED_THRESHOLD; i += 1) {
      noteAiServiceFailure("ai request failed (HTTP 502)");
    }
    expect(useAiServiceHealthStore.getState().degraded).toBe(true);
    expect(useAiServiceHealthStore.getState().reason).toBe("unreachable");
  });

  it("does NOT degrade on a lone 502 — the non-flappy guard", () => {
    noteAiServiceFailure("ai request failed (HTTP 502)");
    expect(useAiServiceHealthStore.getState().degraded).toBe(false);
  });

  it("CLEARS degradation from a non-chatOnce success — the recovery path", () => {
    useAiServiceHealthStore.setState({
      consecutiveFailures: AI_SERVICE_DEGRADED_THRESHOLD,
      degraded: true,
      reason: "unreachable",
      dismissed: false,
    });
    noteAiServiceHealthy();
    expect(useAiServiceHealthStore.getState().degraded).toBe(false);
  });

  it("ignores non-string rejections and the offline sentinel (OfflineBanner owns offline)", () => {
    for (let i = 0; i < AI_SERVICE_DEGRADED_THRESHOLD + 2; i += 1) noteAiServiceFailure("ai_unreachable");
    noteAiServiceFailure(new Error("boom"));
    noteAiServiceFailure(undefined);
    expect(useAiServiceHealthStore.getState().degraded).toBe(false);
  });

  it("chatOnce end-to-end: sustained rejections degrade, a success clears", async () => {
    useAiServiceHealthStore.setState({ ...HEALTHY_SERVICE });
    invokeMock.mockRejectedValue("ai request failed (HTTP 502)");
    for (let i = 0; i < AI_SERVICE_DEGRADED_THRESHOLD; i += 1) {
      await expect(chatOnce("sys", "usr")).rejects.toThrow();
    }
    expect(useAiServiceHealthStore.getState().degraded).toBe(true);
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("ok");
    await chatOnce("sys", "usr");
    expect(useAiServiceHealthStore.getState().degraded).toBe(false);
  });
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

  // The eight `insufficient_credits` balance-bookkeeping cases that used to sit here are GONE with
  // the metered proxy: there is no Sparkle balance on this route to exhaust, so the Rust side cannot
  // produce that sentinel. The credit machinery itself is untouched and still covered by
  // credits.test.ts / aiGate.test.ts — it just no longer sits on this path.

  it("maps ai_unconfigured to ClaudeMissingError and RECORDS the outage", async () => {
    // The silence this closes is the same one main's provider banner was built for; only the cause
    // changed. Recording it here — at the one chokepoint every call passes — is what lets
    // ProviderUnavailableBanner name it for whichever feature happens to fail first.
    useAiProviderStore.setState({ outage: null });
    invokeMock.mockRejectedValue("ai_unconfigured");
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeMissingError);
    expect(err).toBeInstanceOf(AiUnavailableError); // existing defer paths keep working
    expect((err as AiUnavailableError).reason).toBe("cli_missing");
    expect((err as Error).message).toMatch(/Claude Code CLI/);
    expect(useAiProviderStore.getState().outage?.reason).toBe("cli_missing");
  });

  it("maps claude_not_authenticated to ClaudeAuthError and says to sign in", async () => {
    useAiProviderStore.setState({ outage: null });
    invokeMock.mockRejectedValue("claude_not_authenticated");
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeAuthError);
    expect((err as Error).message).toMatch(/Sign in to Claude Code/);
    expect(useAiProviderStore.getState().outage?.reason).toBe("cli_not_authenticated");
  });

  it("maps claude_usage_limit to ClaudeUsageLimitError, which recovers on its own", async () => {
    useAiProviderStore.setState({ outage: null });
    invokeMock.mockRejectedValue("claude_usage_limit");
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeUsageLimitError);
    expect(useAiProviderStore.getState().outage?.reason).toBe("usage_limit");
  });

  // THE distinction the retry budgets depend on. Both are retryable and neither is an outage or a
  // network failure — but only ONE of them is free, and callers exempt only that one from their
  // bounded attempt caps. Grouping them was a real bug: a timeout is produced only after the CLI ran
  // its FULL wall clock (60s classify / 180s chat), so it spent the user's quota, and for a wedged
  // CLI it is deterministic rather than bursty. Exempting it turned the naming backstop into one
  // continuously-running child per agent forever.
  it("treats a saturated pool as FREE — its own class, exempt from retry budgets", async () => {
    useAiProviderStore.setState({ outage: null });
    useConnectionStore.setState({ isOnline: true });
    invokeMock.mockRejectedValue("ai_busy");
    const err = await chatOnce("sys", "usr").catch((e) => e);
    expect(err).toBeInstanceOf(AiBusyError);
    expect(err).not.toBeInstanceOf(AiTransientError); // billed and free must not be one class
    expect(err).not.toBeInstanceOf(AiUnavailableError); // retryable, not deferrable
    expect(err).not.toBeInstanceOf(AiUnreachableError);
    expect(useAiProviderStore.getState().outage).toBeNull(); // never lights the named-reason banner
    expect(useConnectionStore.getState().isOnline).toBe(true); // says nothing about the network
  });

  it("treats a timeout / throttle as BILLED — retryable, but not exempt", async () => {
    for (const sentinel of ["ai_timeout", "ai_rate_limited"] as const) {
      useAiProviderStore.setState({ outage: null });
      useConnectionStore.setState({ isOnline: true });
      invokeMock.mockRejectedValue(sentinel);
      const err = await chatOnce("sys", "usr").catch((e) => e);
      expect(err).toBeInstanceOf(AiTransientError);
      expect(err).not.toBeInstanceOf(AiBusyError); // must NOT reach the exempt class
      expect(err).not.toBeInstanceOf(AiUnavailableError);
      expect(useAiProviderStore.getState().outage).toBeNull();
      expect(useConnectionStore.getState().isOnline).toBe(true);
      // A modal renders `.message`, so it must be a sentence rather than the raw sentinel.
      expect((err as Error).message).not.toContain(sentinel);
    }
  });

  it("clears a recorded outage as soon as a call succeeds", async () => {
    // Recovery must be automatic: the banner has no dismiss control precisely because the user can
    // do nothing about it, so a stale outage would be permanent for the session.
    useAiProviderStore.setState({ outage: { reason: "cli_not_authenticated", at: 1 } });
    invokeMock.mockResolvedValue("hello");
    await chatOnce("sys", "usr");
    expect(useAiProviderStore.getState().outage).toBeNull();
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

// Replaces the old "hard credit gate" suite, which asserted the OPPOSITE: that a zero balance threw
// OutOfCreditsError before `invoke` was reached. That gate was correct while the call spent Sparkle
// credits through the metered proxy. It is wrong now — the call spends the USER'S OWN Claude
// subscription, so refusing it on a Sparkle balance would disable a feature that costs Sparkle
// nothing, behind a gate no top-up could ever satisfy.
describe("no local credit gate — the call spends the user's own subscription", () => {
  it("chatOnce still reaches invoke at a zero balance", async () => {
    fund(0);
    invokeMock.mockResolvedValue("hello");
    await expect(chatOnce("sys", "usr")).resolves.toBe("hello");
    expect(invokeMock).toHaveBeenCalled();
  });

  it("chatOnce still reaches invoke when signed out of Sparkle entirely", async () => {
    // The strongest form: these features no longer require a Sparkle account at all, because the
    // Rust side's bearer read is gone too.
    useAuthStore.setState({ me: null, tokenPresent: false, loading: false });
    invokeMock.mockResolvedValue("hello");
    await expect(chatOnce("sys", "usr")).resolves.toBe("hello");
    expect(invokeMock).toHaveBeenCalled();
  });

  it("structuredJson still reaches invoke at a zero balance", async () => {
    fund(0);
    invokeMock.mockResolvedValue('{"a":1}');
    await expect(structuredJson("sys", "usr")).resolves.toEqual({ a: 1 });
    expect(invokeMock).toHaveBeenCalled();
  });

  it("forwards the background flag so auto-fired callers take the background tier", async () => {
    invokeMock.mockResolvedValue("ok");
    await chatOnce("sys", "usr", 256, { purpose: "Suggesting next actions", background: true });
    const [, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.background).toBe(true);
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
