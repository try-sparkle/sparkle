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
  isRetiredConciergeSession,
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
  fallbackConfigDirs: string[];
} {
  const call = harness.invokes.filter((c) => c.cmd === "concierge_turn").at(n);
  if (!call) throw new Error(`expected a concierge_turn invoke #${n}`);
  return call.args as {
    prompt: string;
    resumeSessionId: string | null;
    configDir: string | null;
    fallbackConfigDirs: string[];
  };
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
      // No accounts planted → no healthy alternative → an empty rotation list (the last-account guard).
      fallbackConfigDirs: [],
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

  it("hands the turn the healthy alternative accounts as fallbackConfigDirs, so Rust can rotate off an auth-dead account in ONE turn", async () => {
    // Parks on the default (lowest-usage tie, first listed); `work` is the healthy dedicated
    // alternative. Without this list Rust has nothing to rotate TO and the turn dies at "sign in to
    // Claude" — the founder's bug. Asserting the list on the payload, because the payload is the
    // whole mechanism (exactly as the configDir tests above do).
    await startConciergeTurn("hi");
    expect(turnArgs(0).configDir).toBe("/home/.claude");
    expect(turnArgs(0).fallbackConfigDirs).toEqual(["/data/accounts/work"]);
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

  it("does not DENY-LIST the other account's conversation when a turn spans a switch", async () => {
    // Where the two mechanisms meet, and the one place they disagree about what an epoch bump MEANS.
    //
    // `rebindSessionToAccount` nulls both session pointers and bumps `sessionEpoch`, so an in-flight
    // turn's `done` lands looking exactly like an abandoned transcript from a previous human: not
    // current, and with neither pointer holding its id — the precise shape the sign-out retirement
    // is built to deny-list. It is not one. An account switch is the SAME human, and that id is the
    // other account's live conversation, sitting in its own tree where it still resumes fine.
    //
    // Retiring it is unrecoverable, which is what makes this worth a test rather than a comment: the
    // deny-list is durable (localStorage), so switching back would refuse the conversation for ever,
    // silently, with no way for the human to undo it. What separates the two cases is WHY the epoch
    // moved — a reset, not a rebind — and the two tests below pin that it is the reason rather than
    // the account binding, which moves back and forth under both.
    let turnSeq = 0;
    harness.invokeImpl = (cmd) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      // Distinct ids per turn: the retirement only reaches TRACKED turns, and reusing one id would
      // re-stamp it at the current epoch and quietly make the turn "current" again.
      if (cmd === "concierge_turn") return Promise.resolve(`turn-${++turnSeq}`);
      return undefined;
    };

    await startConciergeTurn("first"); // spawns under `def`, and does not finish yet

    setPin(CONCIERGE_ACCOUNT_KEY, "work");
    invalidateAccountState();
    await startConciergeTurn("second");

    // Only NOW does the first turn come back, having written to `def`'s tree all along.
    harness.handlers.get("concierge:done")?.({
      payload: { id: "turn-1", sessionId: "sess-on-def", text: "ok" },
    });

    expect(isRetiredConciergeSession("sess-on-def")).toBe(false);
  });

  it("does not deny-list the conversation when the account switches AWAY and BACK again", async () => {
    // THE SNAPSHOT TRAP. Judging this by comparing the turn's account against the binding as it
    // stands when `done` arrives is not the same as asking whether the binding MOVED: the binding is
    // a live value that comes back. Switch away and back while turn-1 is still running and its
    // account equals the current one again, so the comparison reads "no switch happened" and retires
    // the conversation it was added to protect — permanently, and now with no gesture left that
    // would ever restore it. Phase 2's rotation reaches this with no human involvement at all.
    //
    // The reason the epoch moved is the durable fact; the account binding is not.
    let turnSeq = 0;
    harness.invokeImpl = (cmd) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      if (cmd === "concierge_turn") return Promise.resolve(`turn-${++turnSeq}`);
      return undefined;
    };

    await startConciergeTurn("first"); // spawns under `def`, and does not finish yet

    setPin(CONCIERGE_ACCOUNT_KEY, "work");
    invalidateAccountState();
    await startConciergeTurn("second");

    setPin(CONCIERGE_ACCOUNT_KEY, "def"); // …and back again, before turn-1 has reported
    invalidateAccountState();
    await startConciergeTurn("third");

    harness.handlers.get("concierge:done")?.({
      payload: { id: "turn-1", sessionId: "sess-on-def", text: "ok" },
    });

    expect(isRetiredConciergeSession("sess-on-def")).toBe(false);
  });

  it("still retires a signed-out human's session when the next human lands on ANOTHER account", async () => {
    // THE OTHER DIRECTION OF THE SAME MISTAKE, and the one that leaks rather than loses. Sign-out
    // clears the binding, but the next human's first turn installs one — and if it resolves to a
    // different account than the previous human's in-flight turn ran under (a changed pin, a removed
    // account, rotation), an account comparison reads that as a switch and waves the retirement
    // through. The id then stays seedable, so the next launch probes that tree, finds the previous
    // human's transcript as the newest one, and resumes their conversation behind an empty column —
    // exactly the leak the deny-list exists for (roborev 55774/55794).
    let turnSeq = 0;
    harness.invokeImpl = (cmd) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      if (cmd === "concierge_turn") return Promise.resolve(`turn-${++turnSeq}`);
      return undefined;
    };

    await startConciergeTurn("user A's question"); // under `def`, still in flight

    resetConciergeSession(); // sign-out: both pointers are already null, so nothing is retired here

    setPin(CONCIERGE_ACCOUNT_KEY, "work");
    invalidateAccountState();
    await startConciergeTurn("user B's question"); // the binding is now `work`

    // Only now does user A's turn come back, on a session it MINTED — an id the reset never saw.
    harness.handlers.get("concierge:done")?.({
      payload: { id: "turn-1", sessionId: "sess-user-a", text: "A's private answer" },
    });

    expect(isRetiredConciergeSession("sess-user-a")).toBe(true);
  });

  it("does not deny-list a turn that started AFTER the sign-out and was orphaned by a switch", async () => {
    // THE ORDERING IS THE MECHANISM, so it needs a case that only the ordering passes. Every other
    // test here runs with no reset at all, or with a reset that happened AFTER the turn under test
    // started — so all of them stay green if `startedAt <= lastResetEpoch` degrades to "a reset
    // happened at some point" (`lastResetEpoch !== null`).
    //
    // That degenerate form is wrong in exactly the way this guard exists to prevent, and it is the
    // COMMON case rather than an exotic one: once any sign-out has occurred in the process, every
    // later turn orphaned by a mere account rebind — a manual switch, or Phase 2's rotation, which
    // needs no human gesture — would be written to the durable deny-list. The conversation belongs
    // to the human sitting there now, and losing it is permanent and silent.
    let turnSeq = 0;
    harness.invokeImpl = (cmd) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      if (cmd === "concierge_turn") return Promise.resolve(`turn-${++turnSeq}`);
      return undefined;
    };

    resetConciergeSession(); // user A signs out FIRST — the reset is already behind us

    await startConciergeTurn("user B's first message"); // …so this turn is B's, not A's

    setPin(CONCIERGE_ACCOUNT_KEY, "work"); // B moves accounts while their own turn is still running
    invalidateAccountState();
    await startConciergeTurn("user B's second message");

    // B's first turn minted its own session and comes back only now. A rebind orphaned it; no reset
    // did. It is B's live conversation, sitting in `def`'s tree where it still resumes fine.
    harness.handlers.get("concierge:done")?.({
      payload: { id: "turn-1", sessionId: "sess-minted-by-b", text: "ok" },
    });

    expect(isRetiredConciergeSession("sess-minted-by-b")).toBe(false);
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

  it("keeps the RESUME and the CONFIG DIR on the same tree when the lookup hiccups", async () => {
    // The invariant, stated as one assertion: a resume id exists in exactly one account's
    // transcript tree, so the turn's `configDir` must name that same tree. Retaining the pointer
    // while spawning under the DEFAULT account is not a half-fix, it is strictly worse than
    // dropping the pointer — the send path pays a wasted `claude` on its self-heal and loses the
    // conversation anyway, and the proactive path (no retry, by design) dies silently.
    setPin(CONCIERGE_ACCOUNT_KEY, "work");
    await startConciergeTurn("first");
    expect(turnArgs(0).configDir).toBe("/data/accounts/work");
    harness.handlers.get("concierge:done")?.({
      payload: { id: "1", sessionId: "sess-on-work", text: "ok" },
    });

    const good = harness.invokeImpl;
    harness.invokeImpl = (cmd, args) =>
      cmd.startsWith("accounts_") ? Promise.reject(new Error("ipc hiccup")) : good?.(cmd, args);
    invalidateAccountState();

    await startConciergeTurn("second");
    expect(turnArgs(1).resumeSessionId).toBe("sess-on-work");
    // …and under the account that id actually lives in, NOT the default.
    expect(turnArgs(1).configDir).toBe("/data/accounts/work");
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

  it("does not pair a done from the OLD account with the NEW account's config dir", async () => {
    // `concierge:done` is an independent writer of the session pointer and carries no account of
    // its own. A turn spawned under `work` can land its `done` inside the NEXT turn's preamble —
    // several IPC hops wide — after that turn has already rebound to `def`. The id then belongs to
    // `work`'s transcript tree while the binding says `def`, the two LOOK consistent, and the turn
    // spawns `--resume <work-id>` under `$HOME/.claude`.
    let doneIsPending = false;
    harness.invokeImpl = (cmd) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      // Real turn ids: the account stamp is keyed by them, so a harness returning undefined would
      // make this test vacuous by never recording one.
      if (cmd === "concierge_turn") return Promise.resolve("t1");
      if (cmd === "concierge_session_info") {
        // Fire the stale `done` from INSIDE the second turn's preamble — after its first rebind has
        // nulled the pointers, before it computes `resume`.
        if (doneIsPending) {
          doneIsPending = false;
          harness.handlers.get("concierge:done")?.({
            payload: { id: "t1", sessionId: "sess-on-work", text: "ok" },
          });
        }
        return Promise.resolve({ hasSession: false, latestSessionId: null });
      }
      return undefined;
    };

    setPin(CONCIERGE_ACCOUNT_KEY, "work");
    await startConciergeTurn("first");
    expect(turnArgs(0).configDir).toBe("/data/accounts/work");

    setPin(CONCIERGE_ACCOUNT_KEY, "def");
    invalidateAccountState();
    doneIsPending = true;
    await startConciergeTurn("second");

    expect(turnArgs(1).configDir).toBe("/home/.claude");
    // …and NOT carrying `work`'s id into it.
    expect(turnArgs(1).resumeSessionId).toBeNull();
  });

  it("does not let a probe started BEFORE a switch seed the account it lands after", async () => {
    // The restore is two IPC hops including a transcript-directory scan, so a probe for account B
    // can still be in flight when the user switches again. It captured `startedAt = sessionEpoch`
    // before that second switch, and the switch nulls `currentSessionId` — so without the epoch
    // bump BOTH seed guards would pass when it finally lands, seeding B's session id and stamping
    // the binding as B while the turn is running on A. The next turn then resumes cross-tree: the
    // exact failure `rebindSessionToAccount` exists to prevent, reintroduced by the re-probe that
    // was added to fix it.
    //
    // Reaching that state needs TWO switches, because only a switch clears the memo and so only a
    // switch can start a probe that is still outstanding when the next one arrives.
    let releaseWork: () => void = () => {};
    harness.invokeImpl = (cmd, args) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      if (cmd === "concierge_session_info") {
        const dir = (args as { configDir?: string | null })?.configDir;
        // `work`'s probe is held open across the second switch; the default's answers immediately.
        if (dir === "/data/accounts/work") {
          return new Promise((r) => {
            releaseWork = () => r({ hasSession: true, latestSessionId: "sess-on-work" });
          });
        }
        // The DEFAULT tree is deliberately empty. If it seeded a session, `currentSessionId` would
        // be non-null when the stale probe lands and the OTHER seed guard would block it — the test
        // would then pass with the epoch bump removed, proving nothing about the guard under test.
        return Promise.resolve({ hasSession: false, latestSessionId: null });
      }
      return undefined;
    };

    // Turn 1 establishes the binding (def) — a switch is only detectable against a known account.
    await startConciergeTurn("first");
    expect(turnArgs(0).configDir).toBe("/home/.claude");

    // Switch 1 → work. NOT awaited: its restore probes `work`, which we are holding open.
    setPin(CONCIERGE_ACCOUNT_KEY, "work");
    invalidateAccountState();
    const stalledTurn = startConciergeTurn("second");
    for (let i = 0; i < 50; i++) await Promise.resolve();

    // Switch 2 → back to def, while work's probe is still outstanding.
    setPin(CONCIERGE_ACCOUNT_KEY, "def");
    invalidateAccountState();
    // Index 1, not 2: turn "second" is still parked on its probe and has not invoked yet, so this
    // is only the SECOND `concierge_turn` to reach Rust.
    await startConciergeTurn("third");
    expect(turnArgs(1).configDir).toBe("/home/.claude");

    // The stale probe finally lands, into a state where the OTHER seed guard cannot save us:
    // `currentSessionId` is null (the default tree is empty). Only the epoch bump retires it.
    expect(getConciergeSessionId()).toBeNull();
    releaseWork();
    await stalledTurn;
    expect(getConciergeSessionId()).not.toBe("sess-on-work");
  });
});
