// The concierge service's contract with U1/U7 (bead sparkle-ma6e): startConciergeTurn invokes
// `concierge_turn` with the prompt + resume id, the sessionId from each `concierge:done` is
// captured and auto-passed as the resume target on the NEXT turn (one ongoing conversation),
// subscriptions fan out with synchronous unsubscribe, and NOTHING here throws to callers — a
// rejected invoke surfaces as a synthetic error event. Tauri invoke/listen are mocked with the
// same name-keyed harness improvementPass.watchdog.test.ts uses.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";

type Handler = (ev: { payload: unknown }) => void;
const harness = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  invokes: [] as Array<{ cmd: string; args: unknown }>,
  // Per-test overrides keyed by COMMAND/EVENT NAME; return undefined to use the default.
  // concierge_turn resolves with the turn's id now, so this is `unknown`, not `void`.
  // Takes `args` as well as `cmd` (mirroring improvementPass.watchdog.test.ts): the account tests
  // below have to answer `concierge_session_info` DIFFERENTLY per configDir, which is the whole
  // point of a per-account transcript tree and cannot be expressed from the command name alone.
  invokeImpl: undefined as
    | ((cmd: string, args?: unknown) => Promise<unknown> | undefined)
    | undefined,
  listenImpl: undefined as ((name: string) => Promise<() => void> | undefined) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: unknown) => {
    harness.invokes.push({ cmd, args });
    return harness.invokeImpl?.(cmd, args) ?? Promise.resolve();
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
  isSupersededDetail,
  onConciergeDelta,
  onConciergeDone,
  onConciergeError,
  resetConciergeSession,
  startConciergeTurn,
  SUPERSEDED_DETAILS,
} from "./concierge";
import {
  invalidateAccountState,
  resetStickyAccounts,
  CONCIERGE_ACCOUNT_KEY,
} from "./accountSelection";
import { setPin, clearAllPins } from "./accountStore";


// The concierge's AI-enhancements gate (bead sparkle-4562) is a real precondition for a turn and
// for every tool call, so these suites — which test the mechanics, not the entitlement — open it
// explicitly. `aiGate.concierge.test.ts` is where the gate's own behaviour is asserted.
function openConciergeAiGate() {
  useSettingsStore.setState({ aiConcierge: true });
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
    creditFloorCents: 0,
  } as never);
}

/** The args of the nth `concierge_turn` invoke (0-based). */
function turnArgs(n: number): {
  prompt: string;
  resumeSessionId: string | null;
  configDir: string | null;
} {
  const call = harness.invokes.filter((c) => c.cmd === "concierge_turn").at(n);
  if (!call) throw new Error(`expected a concierge_turn invoke #${n}`);
  return call.args as { prompt: string; resumeSessionId: string | null; configDir: string | null };
}

describe("concierge service", () => {
  beforeEach(() => {
    openConciergeAiGate();
    harness.handlers.clear();
    harness.invokes.length = 0;
    harness.invokeImpl = undefined;
    harness.listenImpl = undefined;
    // The account snapshot is module-level and TTL-cached, and the sticky selection outlives it, so
    // a choice made by one test would otherwise be served to the next.
    invalidateAccountState();
    resetStickyAccounts();
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
    // configDir is null here because this harness plants no accounts — see the account suite below
    // for the case where one is selected.
    expect(turnArgs(0)).toEqual({
      prompt: "snapshot: all quiet",
      resumeSessionId: null,
      configDir: null,
    });
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

  it("an error event reaches subscribers, throws nothing, and keeps a CONFIRMED session", async () => {
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
    // THIS ASSERTION USED TO BE `toBeNull()`, and that was the bug (spec §3 subsystem C1). A turn
    // that COMPLETED wrote a real transcript to disk, so `sess-A` is recoverable by definition —
    // dropping it here made the concierge forget the entire conversation on the first transient
    // failure, which is the same amnesia a restart used to cause. Nothing is gained by dropping it
    // either: `concierge.rs` already re-runs a failed resuming turn ONCE without `--resume`
    // (`should_retry_without_resume`), so a genuinely dead id self-heals on the next turn and its
    // `done` replaces it with the fresh session. See concierge.session.test.ts for the fallback rules
    // in full, including the case where an UNCONFIRMED resume override is still discarded.
    expect(getConciergeSessionId()).toBe("sess-A");
    await startConciergeTurn("second");
    expect(turnArgs(1).resumeSessionId).toBe("sess-A");
  });

  // The OTHER half of the cross-language contract, and the half the parametrized test below cannot
  // give (roborev 53392/53397): feeding SUPERSEDED_DETAILS into its own matcher is tautological —
  // reword either entry and the behaviour test stays green, because it rejects with whatever the
  // constant now says and then asserts that same string matched. The Rust sibling
  // (`the_silent_outcome_sentinels_are_the_strings_the_frontend_matches` in concierge.rs) pins only
  // Rust's literals and never reads this file, so before this assertion existed NOTHING pinned that
  // the two sides AGREE. A TS-side reword would have shipped green while `startConciergeTurn`
  // silently stopped matching Rust's SUPERSEDED_ERR / CANCELLED_ERR — restoring "I couldn't reach my
  // brain just now" plus a setTyping(false) over a turn that is still streaming.
  //
  // These literals are copied from concierge.rs's SUPERSEDED_ERR / CANCELLED_ERR ON PURPOSE. The
  // duplication IS the guard: change one side and exactly one of the two tests goes red.
  it("pins the sentinel literals Rust emits, so a reword on either side fails somewhere", () => {
    expect(SUPERSEDED_DETAILS).toEqual([
      "concierge_turn: superseded before install",
      "concierge_turn: cancelled",
    ]);
  });

  // A superseded turn is not a failed one, and only a FAILED turn should cost the session
  // (roborev 53460/53462). The retry path can emit `concierge:error` carrying the sentinel for a turn
  // the user displaced — dropping the id there makes the NEXT turn start a fresh Claude session, so
  // the concierge forgets the entire conversation while the turn that displaced it is still talking
  // in that very session.
  it("a SUPERSEDED error event keeps the session; a real failure still drops it", async () => {
    await startConciergeTurn("first");
    harness.handlers.get("concierge:done")?.({
      payload: { id: "1", sessionId: "sess-KEEP", text: "ok" },
    });
    expect(getConciergeSessionId()).toBe("sess-KEEP");

    // Superseded — the session survives, and the next turn still resumes into it.
    harness.handlers.get("concierge:error")?.({
      payload: { id: "1", detail: SUPERSEDED_DETAILS[0] },
    });
    expect(getConciergeSessionId()).toBe("sess-KEEP");
    await startConciergeTurn("second");
    expect(turnArgs(1).resumeSessionId).toBe("sess-KEEP");

    // Folded into a longer detail by the retry path — still a supersession, still not a failure.
    harness.handlers.get("concierge:error")?.({
      payload: { id: "1", detail: `something else; ${SUPERSEDED_DETAILS[1]}` },
    });
    expect(getConciergeSessionId()).toBe("sess-KEEP");

    // Now the half that still tells the two paths apart. Since C1, a real failure no longer drops the
    // session to NOTHING — it drops back to the last one a `done` (or the boot restore) confirmed. So
    // the discriminating case is an UNCONFIRMED resume target: `startConciergeTurn` advances the
    // session optimistically on an accepted invoke, including an explicit override, and only a real
    // failure discards that.
    await startConciergeTurn("third", "sess-UNCONFIRMED");
    expect(getConciergeSessionId()).toBe("sess-UNCONFIRMED");

    // Superseded — a no-op, exactly as above. The override stands.
    harness.handlers.get("concierge:error")?.({
      payload: { id: "3", detail: SUPERSEDED_DETAILS[0] },
    });
    expect(getConciergeSessionId()).toBe("sess-UNCONFIRMED");

    // A GENUINE failure discards the unconfirmed guess, falling back to the confirmed conversation
    // rather than starting the user over from scratch.
    harness.handlers.get("concierge:error")?.({
      payload: { id: "3", detail: "Claude usage limit reached" },
    });
    expect(getConciergeSessionId()).toBe("sess-KEEP");
  });

  it("isSupersededDetail matches the sentinels as substrings and nothing else", () => {
    for (const d of SUPERSEDED_DETAILS) {
      expect(isSupersededDetail(d)).toBe(true);
      expect(isSupersededDetail(`wrapped: ${d} (code 1)`)).toBe(true);
    }
    expect(isSupersededDetail("Claude usage limit reached")).toBe(false);
    expect(isSupersededDetail("")).toBe(false);
  });

  it.each(SUPERSEDED_DETAILS.map((d) => [d] as const))(
    "a send rejected with %s resolves null SILENTLY — no error bubble, no typing reset",
    async (detail) => {
      // Both are ordinary outcomes of two fast sends. Surfacing them would post "I couldn't reach
      // my brain just now" and clear the typing indicator for the turn that IS running: a local
      // error carries no turn id, so it bypasses supersededTurn entirely (roborev 53186). Driven
      // from the exported constant so the BEHAVIOUR is pinned for whatever the sentinels are; the
      // literals themselves are pinned by the test above (roborev 53392).
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

// ── Which Claude account a turn runs under (PRD/sparkle/account-rotation.md Phase 0) ───────────
//
// THE BUG THIS COVERS. The concierge spawn set only PATH on its child, so every turn authenticated
// from `$HOME/.claude` — the `isDefault` account — regardless of which account the human had
// selected or signed into. When that account hit its limit, 15 consecutive turns failed with
// `You've hit your monthly spend limit` / `You've hit your session limit` and NOTHING the human
// could do moved the concierge off it. The fix is that `configDir` reaches the invoke; these assert
// exactly that, on the payload, because the payload is the whole mechanism.
describe("concierge account binding", () => {
  const ACCOUNTS = [
    { id: "def", nickname: "Default", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
    { id: "work", nickname: "Work", configDir: "/data/accounts/work", isDefault: false, createdAt: 2 },
  ];

  beforeEach(() => {
    openConciergeAiGate();
    harness.handlers.clear();
    harness.invokes.length = 0;
    harness.listenImpl = undefined;
    harness.invokeImpl = (cmd) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      return undefined;
    };
    clearAllPins();
    invalidateAccountState();
    resetStickyAccounts();
    _resetConciergeForTests();
  });

  /** The `configDir` the boot restore probed with. */
  function restoreConfigDir(): string | null | undefined {
    const call = harness.invokes.find((c) => c.cmd === "concierge_session_info");
    if (!call) throw new Error("expected a concierge_session_info invoke");
    return (call.args as { configDir?: string | null }).configDir;
  }

  it("probes the SAME account's transcript tree that the turn will run under", async () => {
    // The restore is the other half of the account binding, and getting it wrong is not a no-op:
    // probing $HOME/.claude while the child writes to the selected account either finds nothing
    // (an amnesiac concierge on every restart) or finds a FOREIGN id and seeds it — so the next
    // turn spawns `--resume <foreign-id>`, fails, and burns a second claude on the self-heal.
    setPin(CONCIERGE_ACCOUNT_KEY, "work");
    await startConciergeTurn("hello");
    expect(restoreConfigDir()).toBe("/data/accounts/work");
    // …and it is the same account the turn itself ran under. Asserting both together is the point:
    // a probe and a spawn that disagree is exactly the defect.
    expect(turnArgs(0).configDir).toBe("/data/accounts/work");
  });

  it("starts a FRESH conversation when the account changes, rather than a doomed --resume", async () => {
    await startConciergeTurn("first");
    harness.handlers.get("concierge:done")?.({
      payload: { id: "1", sessionId: "sess-on-def", text: "ok" },
    });
    expect(getConciergeSessionId()).toBe("sess-on-def");

    // Move to another account. `sess-on-def` exists only in the previous account's transcript tree,
    // so resuming it would fail; the send path would self-heal at the cost of a second claude, and
    // a proactive push (no retry, by design) would just die. Dropping the pointer is what avoids
    // both — assert the resume the turn ACTUALLY sends, not merely that the pointer moved.
    setPin(CONCIERGE_ACCOUNT_KEY, "work");
    invalidateAccountState();

    await startConciergeTurn("second");
    expect(turnArgs(1).configDir).toBe("/data/accounts/work");
    expect(turnArgs(1).resumeSessionId).toBeNull();
  });

  it("keeps resuming while the account stays put", async () => {
    // The guard must be a CHANGE detector, not a blanket "never resume" — otherwise it would quietly
    // end session continuity altogether and this suite's other assertions would not notice.
    await startConciergeTurn("first");
    harness.handlers.get("concierge:done")?.({
      payload: { id: "1", sessionId: "sess-A", text: "ok" },
    });
    await startConciergeTurn("second");
    expect(turnArgs(1).resumeSessionId).toBe("sess-A");
  });

  it("sends the selected account's config dir with every turn", async () => {
    await startConciergeTurn("hello");
    expect(turnArgs(0).configDir).toBe("/home/.claude");
  });

  it("follows the account SWITCH — the whole point of Phase 0", async () => {
    await startConciergeTurn("before");
    expect(turnArgs(0).configDir).toBe("/home/.claude");

    // The human moves the concierge to another account. Before this change nothing they could do
    // here changed the account the turn ran under; now the very next turn follows it.
    setPin(CONCIERGE_ACCOUNT_KEY, "work");
    invalidateAccountState();

    await startConciergeTurn("after");
    expect(turnArgs(1).configDir).toBe("/data/accounts/work");
  });

  it("still starts the turn when the account backend is broken", async () => {
    // Inheriting the default account is a degraded outcome; refusing to answer the user is a worse
    // one. A rejecting accounts backend must cost the account choice, not the turn.
    harness.invokeImpl = (cmd) =>
      cmd.startsWith("accounts_") ? Promise.reject(new Error("ipc down")) : undefined;
    invalidateAccountState();
    await startConciergeTurn("hello");
    expect(turnArgs(0).configDir).toBeNull();
  });

  it("does NOT discard the conversation when the account lookup merely hiccups", async () => {
    // An unresolvable backend is not an account CHANGE. Reading it as one nulled the live pointer
    // AND the on-disk fallback over a single failed invoke — the very loss the error path is
    // written to prevent — and then flipped back on the next successful resolve. The contract is
    // "a broken account backend costs you the account choice, not the work", and the work now
    // includes the session pointer.
    await startConciergeTurn("first");
    harness.handlers.get("concierge:done")?.({
      payload: { id: "1", sessionId: "sess-A", text: "ok" },
    });

    const good = harness.invokeImpl;
    harness.invokeImpl = (cmd) =>
      cmd.startsWith("accounts_") ? Promise.reject(new Error("ipc hiccup")) : good?.(cmd);
    invalidateAccountState();

    await startConciergeTurn("second");
    expect(turnArgs(1).resumeSessionId).toBe("sess-A");
    expect(getConciergeSessionId()).toBe("sess-A");
  });

  it("resumes the NEW account's own conversation after a switch, not a blank one", async () => {
    // The restore is memoized for the life of the page, so dropping the pointer on a switch is only
    // half the job: without re-probing, an account that ALREADY holds a conversation would be
    // greeted with a brand-new one — the amnesia subsystem C exists to prevent, moved from the
    // restart path onto the switch path (and onto Phase 2's rotation, which lands here every time).
    harness.invokeImpl = (cmd, args) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      if (cmd === "concierge_session_info") {
        // Each account's tree holds its own transcript — which is the fact the probe must read.
        const dir = (args as { configDir?: string | null })?.configDir;
        const id = dir === "/data/accounts/work" ? "sess-on-work" : "sess-on-def";
        return Promise.resolve({ hasSession: true, latestSessionId: id });
      }
      return undefined;
    };
    await startConciergeTurn("first");
    expect(turnArgs(0).resumeSessionId).toBe("sess-on-def");

    setPin(CONCIERGE_ACCOUNT_KEY, "work");
    invalidateAccountState();

    await startConciergeTurn("second");
    expect(turnArgs(1).configDir).toBe("/data/accounts/work");
    expect(turnArgs(1).resumeSessionId).toBe("sess-on-work");
  });
});
