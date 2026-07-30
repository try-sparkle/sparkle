// C1 — the concierge's MODEL memory survives an app restart (spec §3 subsystem C1).
//
// The conversation was never actually lost: `claude -p` writes a real transcript under the app-data
// dir's slug. Only the pointer to it — a module-level `let` that died with the webview — was thrown
// away, while build agents already re-discovered theirs by probing the same transcript directory at
// spawn. These tests pin the restore, and pin the error path that would otherwise re-orphan the
// session the restore just recovered.
//
// A "simulated reload" is `_resetConciergeForTests()`: the module state is exactly what a fresh
// webview starts with, while the mocked `concierge_session_info` stands in for the transcript that
// is still on disk.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";

type Handler = (ev: { payload: unknown }) => void;
const harness = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  invokes: [] as Array<{ cmd: string; args: unknown }>,
  /** What the on-disk transcript probe reports. `null` = nothing on disk (a first run). */
  diskSessionId: null as string | null,
  /** Make the probe reject, standing in for a missing bridge / unresolvable app-data dir. */
  probeFails: false,
  /** Resolved by the probe's caller-visible promise; set to defer the probe mid-flight. */
  gateProbe: undefined as (() => Promise<void>) | undefined,
  /** Same, for `concierge_turn` — lets a case land a sign-out while a turn's invoke is in flight. */
  gateTurn: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    harness.invokes.push({ cmd, args });
    if (cmd === "concierge_session_info") {
      if (harness.gateProbe) await harness.gateProbe();
      if (harness.probeFails) throw new Error("no app data dir");
      return { hasSession: harness.diskSessionId !== null, latestSessionId: harness.diskSessionId };
    }
    if (cmd === "concierge_turn" || cmd === "concierge_proactive_turn") {
      if (harness.gateTurn) await harness.gateTurn();
      return "turn-1";
    }
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: Handler) => {
    harness.handlers.set(name, handler);
    return Promise.resolve(() => harness.handlers.delete(name));
  }),
}));

import {
  _resetConciergeForTests,
  getConciergeSessionId,
  onConciergeDelta,
  onConciergeDone,
  onConciergeError,
  onConciergeIdentityReset,
  resetConciergeSession,
  restoreConciergeSession,
  setConciergeSessionId,
  startConciergeTurn,
  startProactiveConciergeTurn,
  SUPERSEDED_DETAILS,
} from "./concierge";


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

/** The resume id the nth `concierge_turn` invoke carried (0-based). */
function resumeOf(n: number): string | null {
  const call = harness.invokes.filter((c) => c.cmd === "concierge_turn").at(n);
  if (!call) throw new Error(`expected a concierge_turn invoke #${n}`);
  return (call.args as { resumeSessionId: string | null }).resumeSessionId;
}

const probeCount = () => harness.invokes.filter((c) => c.cmd === "concierge_session_info").length;

/** Wait until the transcript probe is ACTUALLY in flight (and therefore gated by `gateProbe`).
 *
 *  The "…while the probe was in flight" tests below hook that state, and they used to reach it by
 *  assuming `restoreConciergeSession()` runs synchronously up to the probe. It no longer does — the
 *  restore first resolves WHICH ACCOUNT to probe under, since the concierge spawn is account-aware
 *  and the transcript lives in the selected account's tree. Any await before the probe breaks that
 *  assumption, and it breaks it silently in the worst way: `release` is still the no-op default, so
 *  the gate is never opened and the test hangs to its timeout rather than failing.
 *
 *  So establish the precondition instead of assuming it. Drains microtasks (not timers — nothing
 *  here is timer-driven) and asserts, so a restore that stopped probing altogether fails loudly. */
async function untilProbeInFlight() {
  for (let i = 0; i < 50 && probeCount() === 0; i++) await Promise.resolve();
  expect(probeCount()).toBeGreaterThan(0);
}

/**
 * Park a TURN inside its invoke and hand back the release.
 *
 * The sibling of `untilProbeInFlight` above, for the other gated command, and it exists for the same
 * reason that one does: the window under test is between "`resume` and the epoch have been captured"
 * and "the invoke resolved", so a case has to wait until the turn is genuinely in the invoke before
 * it acts — releasing earlier just tests a turn that never started. The invoke record is pushed
 * before the gate is awaited, so its presence is the signal. The deferred is built UP FRONT because
 * the executor only runs when the gate is called, and a `release` captured later is still a no-op —
 * the identical trap `untilProbeInFlight` documents.
 *
 * Polls timers rather than microtasks: the account resolution noted above puts real awaits between
 * the call and the invoke, so draining the microtask queue alone is not guaranteed to get there.
 */
async function parkTurnInFlight(cmd: string): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  harness.gateTurn = () => gate;
  for (let i = 0; i < 100 && !harness.invokes.some((c) => c.cmd === cmd); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!harness.invokes.some((c) => c.cmd === cmd)) throw new Error(`${cmd} never reached its invoke`);
  return release;
}

/** Deliver a Rust event to the module's internal listener. */
function emit(name: "concierge:done" | "concierge:error", payload: unknown): void {
  const h = harness.handlers.get(name);
  if (!h) throw new Error(`no listener for ${name}`);
  h({ payload });
}

describe("concierge session restore (C1)", () => {
  beforeEach(() => {
    openConciergeAiGate();
    harness.handlers.clear();
    harness.invokes.length = 0;
    harness.diskSessionId = null;
    harness.probeFails = false;
    harness.gateProbe = undefined;
    harness.gateTurn = undefined;
    _resetConciergeForTests();
  });

  it("resumes the on-disk session on the FIRST turn after a restart", async () => {
    // THE BUG: before this, a restart made the concierge forget everything the user had said, even
    // though the transcript was sitting right there. The first message after launch is the one that
    // most needs the prior context, so the restore has to complete BEFORE `resume` is computed.
    harness.diskSessionId = "sess-from-disk";
    await startConciergeTurn("hey, where were we");
    expect(resumeOf(0)).toBe("sess-from-disk");
  });

  it("starts fresh when there is no transcript on disk (first run)", async () => {
    harness.diskSessionId = null;
    await startConciergeTurn("hello");
    expect(resumeOf(0)).toBeNull();
    expect(getConciergeSessionId()).toBeNull();
  });

  it("starts the probe at SUBSCRIBE time, so it is off the first send's critical path", async () => {
    harness.diskSessionId = "sess-1";
    // What ConciergeHost does on mount, long before the user types anything.
    const off = onConciergeDone(() => {});
    await restoreConciergeSession();
    expect(getConciergeSessionId()).toBe("sess-1");
    off();
  });

  it("three subscriptions plus a turn still produce exactly ONE probe", async () => {
    harness.diskSessionId = "sess-1";
    onConciergeDelta(() => {});
    onConciergeDone(() => {});
    onConciergeError(() => {});
    await startConciergeTurn("go");
    expect(probeCount()).toBe(1);
  });

  it("probes disk once per page, not once per turn", async () => {
    harness.diskSessionId = "sess-1";
    await startConciergeTurn("one");
    await startConciergeTurn("two");
    expect(probeCount()).toBe(1);
    // The second turn resumes the same session, from memory.
    expect(resumeOf(1)).toBe("sess-1");
  });

  it("never throws when the probe fails; the session is simply fresh", async () => {
    harness.probeFails = true;
    await expect(restoreConciergeSession()).resolves.toBeUndefined();
    expect(getConciergeSessionId()).toBeNull();
    await startConciergeTurn("still works");
    expect(resumeOf(0)).toBeNull();
  });

  // roborev 53666-M. A resolved-but-FAILED probe used to be cached for the life of the page, so one
  // bad probe left the concierge amnesiac for the whole session — the exact bug this subsystem
  // exists to fix. It got likelier when the probe moved off the first send onto three mount-time
  // call sites, where a transient failure during window init is far more plausible.
  it("retries after a failed probe instead of caching the failure forever", async () => {
    harness.probeFails = true;
    await restoreConciergeSession();
    expect(getConciergeSessionId()).toBeNull();
    expect(probeCount()).toBe(1);

    // The disk becomes readable (the bridge finished coming up).
    harness.probeFails = false;
    harness.diskSessionId = "sess-recovered";
    await restoreConciergeSession();
    expect(probeCount()).toBe(2);
    expect(getConciergeSessionId()).toBe("sess-recovered");

    // …and the recovered id is what the next turn actually resumes.
    await startConciergeTurn("after recovery");
    expect(resumeOf(0)).toBe("sess-recovered");
  });

  it("still caches a SUCCESSFUL probe — the retry is failure-only", async () => {
    harness.diskSessionId = "sess-ok";
    await restoreConciergeSession();
    await restoreConciergeSession();
    await restoreConciergeSession();
    expect(probeCount()).toBe(1);
  });

  it("tolerates a bridge that answers with nothing at all", async () => {
    // A non-Tauri host (or a test double) can resolve `undefined`; destructuring that would throw a
    // TypeError into the console on every page load.
    harness.diskSessionId = null;
    await restoreConciergeSession();
    expect(getConciergeSessionId()).toBeNull();
  });

  it("does NOT overwrite a live session id captured while the probe was in flight", async () => {
    // A turn that finished first is real process state; disk is only a fallback.
    let release: () => void = () => {};
    harness.gateProbe = () => new Promise<void>((r) => (release = r));
    harness.diskSessionId = "sess-stale-on-disk";
    const restoring = restoreConciergeSession();
    await untilProbeInFlight();
    // The listeners aren't wired by `restoreConciergeSession` alone, so drive the capture the way a
    // completed turn does.
    setConciergeSessionId("sess-live");
    release();
    await restoring;
    expect(getConciergeSessionId()).toBe("sess-live");
  });

  it("does not resurrect the conversation a user reset while the probe was in flight", async () => {
    let release: () => void = () => {};
    harness.gateProbe = () => new Promise<void>((r) => (release = r));
    harness.diskSessionId = "sess-old";
    const restoring = restoreConciergeSession();
    await untilProbeInFlight();
    resetConciergeSession();
    release();
    await restoring;
    expect(getConciergeSessionId()).toBeNull();
  });

  // roborev 53689-M. The failure-retry drop must not hand back the protection the test above
  // establishes. `resetConciergeSession` marks `restoring` DONE rather than null so an in-flight
  // probe cannot land after the reset; if that probe then FAILS, an identity-only drop would clear
  // the cache and the next call would re-probe with a post-reset epoch — seeding the very
  // conversation the user discarded. The case above cannot catch this: it runs with probeFails
  // false.
  it("does not resurrect it either when the in-flight probe FAILS after the reset", async () => {
    let release: () => void = () => {};
    harness.gateProbe = () => new Promise<void>((r) => (release = r));
    harness.probeFails = true;
    harness.diskSessionId = "sess-old";
    const restoring = restoreConciergeSession();
    await untilProbeInFlight();
    resetConciergeSession();
    release();
    await restoring;
    expect(getConciergeSessionId()).toBeNull();

    // The disk is readable again and still holds the discarded session. A retry here would be the
    // bug: the user asked for a fresh conversation, so the next turn must resume nothing.
    harness.probeFails = false;
    harness.gateProbe = undefined;
    await restoreConciergeSession();
    expect(getConciergeSessionId()).toBeNull();
    await startConciergeTurn("after the reset");
    expect(resumeOf(0)).toBeNull();
  });

  describe("setConciergeSessionId", () => {
    it("points the next turn at the given id", async () => {
      setConciergeSessionId("sess-seeded");
      await startConciergeTurn("go");
      expect(resumeOf(0)).toBe("sess-seeded");
    });

    it("treats null and empty string as 'no session'", () => {
      setConciergeSessionId("sess-x");
      setConciergeSessionId(null);
      expect(getConciergeSessionId()).toBeNull();
      setConciergeSessionId("sess-y");
      setConciergeSessionId("");
      expect(getConciergeSessionId()).toBeNull();
    });

    it("suppresses a later disk restore, since it is authoritative", async () => {
      harness.diskSessionId = "sess-on-disk";
      setConciergeSessionId("sess-explicit");
      await restoreConciergeSession();
      expect(getConciergeSessionId()).toBe("sess-explicit");
    });
  });

  describe("the error path must not re-orphan a restored session", () => {
    it("keeps the session id when an on-disk fallback exists", async () => {
      // THE REGRESSION THIS GUARDS: the listener used to null the session on ANY non-superseded
      // error. With a restore in place that means the first transient failure after launch throws
      // away the conversation that was just recovered — the exact symptom this subsystem fixes,
      // reintroduced one error later.
      //
      // Resuming a possibly-dead id is not the risk it looks like: `concierge.rs` already re-runs a
      // failed resuming turn ONCE without `--resume` (`should_retry_without_resume`), so a genuinely
      // stale id self-heals on the next turn and the `done` below replaces it with the fresh one.
      harness.diskSessionId = "sess-from-disk";
      await startConciergeTurn("first");
      emit("concierge:error", { id: "turn-1", detail: "claude exited with status 1" });
      expect(getConciergeSessionId()).toBe("sess-from-disk");
      await startConciergeTurn("second");
      expect(resumeOf(1)).toBe("sess-from-disk");
    });

    it("still clears it when there is NO fallback (unchanged pre-restore behavior)", async () => {
      harness.diskSessionId = null;
      await startConciergeTurn("first", "sess-explicit-override");
      expect(getConciergeSessionId()).toBe("sess-explicit-override");
      emit("concierge:error", { id: "turn-1", detail: "claude exited with status 1" });
      expect(getConciergeSessionId()).toBeNull();
    });

    it("drops an unconfirmed override back to the confirmed session, not to nothing", async () => {
      // `startConciergeTurn` advances the session optimistically on an accepted invoke, including an
      // explicit override. A turn that then FAILS must be able to discard that override without
      // discarding the conversation the user has actually been having.
      harness.diskSessionId = "sess-real";
      await startConciergeTurn("first");
      await startConciergeTurn("second", "sess-guess");
      expect(getConciergeSessionId()).toBe("sess-guess");
      emit("concierge:error", { id: "turn-1", detail: "claude exited with status 1" });
      expect(getConciergeSessionId()).toBe("sess-real");
    });

    it("leaves the session alone on a supersession sentinel", async () => {
      harness.diskSessionId = "sess-from-disk";
      await startConciergeTurn("first");
      for (const detail of SUPERSEDED_DETAILS) {
        emit("concierge:error", { id: "turn-1", detail });
        expect(getConciergeSessionId()).toBe("sess-from-disk");
      }
    });

    it("does not resurrect a session the user explicitly reset", async () => {
      harness.diskSessionId = "sess-from-disk";
      await startConciergeTurn("first");
      resetConciergeSession();
      emit("concierge:error", { id: "turn-1", detail: "claude exited with status 1" });
      expect(getConciergeSessionId()).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // A RESET IS AN IDENTITY BOUNDARY NOW (roborev 55774).
  //
  // `resetConciergeSession` became reachable from sign-out via `resetConciergeIdentityState`, which
  // promoted two pre-existing write paths from "harmless race" to "the previous human's conversation
  // comes back". Both are asserted here rather than in the seam's own test, because the seam cannot
  // see them: one needs a Rust event delivered mid-flight, the other needs a relaunch.
  describe("a reset is an identity boundary, not just a pointer clear", () => {
    it("refuses a `done` from a turn that started BEFORE the reset", async () => {
      harness.diskSessionId = null;
      // A turn is in flight when the human signs out. Its `done` lands afterwards, carrying the
      // session id it ran under — and installing that is how user A's conversation survived into
      // user B's session with nothing on screen to reveal it.
      await startConciergeTurn("mid-conversation");
      resetConciergeSession();
      expect(getConciergeSessionId()).toBeNull();

      emit("concierge:done", { id: "turn-1", sessionId: "sess-user-a", text: "…" });

      expect(getConciergeSessionId()).toBeNull();
    });

    it("still accepts a `done` from a turn started AFTER the reset — the guard is not a blanket mute", async () => {
      // The refusal above must not degrade into "a reset permanently deafens the listener": the
      // whole point of `done` is to keep the pointer fresh for whoever is signed in now. (The turn
      // here also wires the listeners, which `resetConciergeSession` alone does not.)
      harness.diskSessionId = null;
      await startConciergeTurn("user A's turn");
      resetConciergeSession();

      // User B's turn — a different id, started after the boundary.
      emit("concierge:done", { id: "turn-user-b", sessionId: "sess-user-b", text: "…" });

      expect(getConciergeSessionId()).toBe("sess-user-b");
    });

    it("a turn whose invoke RESOLVES after the reset does not re-install its resume target", async () => {
      // The third write path, and the easiest to miss: `resume` is computed BEFORE the await and
      // written after it, so a sign-out landing in that window was undone by the turn that was
      // already on its way out.
      harness.diskSessionId = "sess-user-a";
      await restoreConciergeSession();
      expect(getConciergeSessionId()).toBe("sess-user-a");

      // `parkTurnInFlight` is armed before the send, and resolves only once the turn is genuinely
      // inside its invoke — i.e. `resume` is already "sess-user-a" and cannot be re-read.
      const parked = parkTurnInFlight("concierge_turn");
      const inFlight = startConciergeTurn("sent just before signing out");
      const release = await parked;

      resetConciergeSession();
      release();
      await inFlight;

      expect(getConciergeSessionId()).toBeNull();
    });

    it("…and the same for a PROACTIVE turn, which starts on its own schedule", async () => {
      // Worse than the send path: nobody chose the moment, so the collision window is not bounded by
      // what the user was doing when they signed out.
      harness.diskSessionId = "sess-user-a";
      await restoreConciergeSession();

      const parked = parkTurnInFlight("concierge_proactive_turn");
      const inFlight = startProactiveConciergeTurn("noticed something");
      const release = await parked;

      resetConciergeSession();
      release();
      await inFlight;

      expect(getConciergeSessionId()).toBeNull();
    });

    it("retires the session a refused `done` MINTED, so a relaunch cannot seed it either", async () => {
      // THE HOLE THE FIRST FIX LEFT (roborev 55794). `resetConciergeSession` can only retire ids it
      // can SEE, and a first turn with no resume target has neither pointer set — so a turn that
      // mints its session mid-flight ends on an id nothing put on the deny-list, whose transcript is
      // then the newest on disk. Refusing it in-process is only half the fix.
      harness.diskSessionId = null; // fresh launch, nothing on disk
      const parked = parkTurnInFlight("concierge_turn");
      const inFlight = startConciergeTurn("user A's first message");
      const release = await parked;

      resetConciergeSession(); // sign-out: both pointers are already null, so nothing is retired here
      release();
      await inFlight;

      // The turn completes on a session that never existed when the reset ran.
      emit("concierge:done", { id: "turn-1", sessionId: "sess-minted-mid-flight", text: "…" });
      expect(getConciergeSessionId()).toBeNull();

      // RELAUNCH: that transcript is now the newest on disk.
      _resetConciergeForTests({ keepRetiredSessions: true });
      harness.diskSessionId = "sess-minted-mid-flight";
      await restoreConciergeSession();

      expect(getConciergeSessionId()).toBeNull();
    });

    it("does not fan a pre-reset turn's DELTAS out to the next human's column", async () => {
      // The visible companion. `ConciergeHost` stays mounted across sign-out and writes streamed
      // text into the persisted thread, so an ungated delta re-fills the column
      // `clearConciergeThread()` just emptied — with the previous human's answer.
      const seen: string[] = [];
      const off = onConciergeDelta((d) => seen.push(d.id));
      harness.diskSessionId = null;
      await startConciergeTurn("user A's question");

      resetConciergeSession();
      harness.handlers.get("concierge:delta")?.({
        payload: { id: "turn-1", text: "…the answer to A's question" },
      });

      expect(seen).toEqual([]);
      off();
    });

    it("does not fan a pre-reset turn's DONE text out to the next human's column", async () => {
      // The `done` carries the full reply text, so it is the single largest thing that could land in
      // the freshly cleared column. Asserted separately from the delta case because they are
      // different listeners: gating one and not the other still delivers the whole answer.
      const seen: string[] = [];
      const off = onConciergeDone((d) => seen.push(d.id));
      harness.diskSessionId = null;
      await startConciergeTurn("user A's question");

      resetConciergeSession();
      emit("concierge:done", { id: "turn-1", sessionId: "sess-user-a", text: "A's private answer" });

      expect(seen).toEqual([]);
      off();
    });

    it("does not apologise to the next human for the previous one's failed turn", async () => {
      const seen: string[] = [];
      const off = onConciergeError((e) => seen.push(e.id));
      harness.diskSessionId = "sess-user-a";
      await startConciergeTurn("user A's question");

      resetConciergeSession();
      emit("concierge:error", { id: "turn-1", detail: "claude exited with status 1" });

      expect(seen).toEqual([]);
      // …and it must not roll the pointer back to a fallback the reset cleared, either.
      expect(getConciergeSessionId()).toBeNull();
      off();
    });

    it("still fans out for a turn that belongs to the CURRENT human", async () => {
      // The guard must not degrade into "a reset permanently mutes the column".
      const deltas: string[] = [];
      const off = onConciergeDelta((d) => deltas.push(d.id));
      resetConciergeSession();
      harness.diskSessionId = null;
      await startConciergeTurn("user B's question");

      harness.handlers.get("concierge:delta")?.({ payload: { id: "turn-1", text: "hello B" } });

      expect(deltas).toEqual(["turn-1"]);
      off();
    });

    it("refuses to restore a RETIRED session across a relaunch", async () => {
      // The half `sessionEpoch` and `restoring` cannot reach: both are process state, so quitting
      // after a sign-out cleared them and the boot probe re-seeded the same transcript.
      harness.diskSessionId = "sess-user-a";
      await restoreConciergeSession();
      expect(getConciergeSessionId()).toBe("sess-user-a");

      resetConciergeSession();
      expect(getConciergeSessionId()).toBeNull();

      // THE RELAUNCH: module state is what a fresh webview starts with; the transcript is still the
      // newest one on disk; only the durable retirement survives with it.
      _resetConciergeForTests({ keepRetiredSessions: true });
      await restoreConciergeSession();

      expect(getConciergeSessionId()).toBeNull();
    });

    it("never retires the id the module is CURRENTLY holding (roborev 55813)", async () => {
      // "Not current" is not the same as "a different human". `sessionEpoch` moves on
      // `setConciergeSessionId` too — the exported "learns the session from outside the event
      // stream" seam — so a deliberate set during an in-flight turn made that turn's `done` look
      // pre-reset, and an unconditional retire then deny-listed the LIVE conversation. It kept
      // working for the rest of the run and was refused for ever after the next launch: silent,
      // permanent, and with no way to undo it.
      harness.diskSessionId = null;
      await startConciergeTurn("still talking");
      setConciergeSessionId("sess-live");

      emit("concierge:done", { id: "turn-1", sessionId: "sess-live", text: "…" });

      // The pointer is the weak assertion; the durable one is that a relaunch can still seed it.
      expect(getConciergeSessionId()).toBe("sess-live");
      _resetConciergeForTests({ keepRetiredSessions: true });
      harness.diskSessionId = "sess-live";
      await restoreConciergeSession();

      expect(getConciergeSessionId()).toBe("sess-live");
    });

    it("tells subscribers the turn was ABANDONED, since its terminal event never arrives", async () => {
      // The other half of the fan-out gate. Refusing the `done` is right for its content, but
      // `done`/`error` are the only two signals that stand the host's typing indicator down and
      // unlatch its liveness escalation — neither of which is store state the identity reset can
      // reach. Silence alone left the spinner running for the next human over an empty column.
      const doneSeen: string[] = [];
      let abandoned = 0;
      const offDone = onConciergeDone((d) => doneSeen.push(d.id));
      const offReset = onConciergeIdentityReset(() => {
        abandoned += 1;
      });
      harness.diskSessionId = null;
      await startConciergeTurn("user A's question");

      resetConciergeSession();
      emit("concierge:done", { id: "turn-1", sessionId: "sess-user-a", text: "A's private answer" });

      expect(doneSeen).toEqual([]); // the content is still refused…
      expect(abandoned).toBe(1); // …and the host is told, exactly once.
      offDone();
      offReset();
    });

    it("unsubscribing really stops the abandonment signal", async () => {
      // The host tears this down on unmount alongside the other three. A returned no-op would leak
      // a closure over a stale `setTyping` for the life of the process.
      let abandoned = 0;
      const offReset = onConciergeIdentityReset(() => {
        abandoned += 1;
      });
      offReset();

      resetConciergeSession();

      expect(abandoned).toBe(0);
    });

    it("still restores a DIFFERENT session after a relaunch — retirement is per-id, not a kill switch", async () => {
      harness.diskSessionId = "sess-user-a";
      await restoreConciergeSession();
      resetConciergeSession();

      // User B has since had a conversation of their own; that transcript is now the newest.
      _resetConciergeForTests({ keepRetiredSessions: true });
      harness.diskSessionId = "sess-user-b";
      await restoreConciergeSession();

      expect(getConciergeSessionId()).toBe("sess-user-b");
    });
  });

  it("a completed turn refreshes the fallback, so the self-heal's fresh session sticks", async () => {
    // Rust's stale-resume retry starts a BRAND NEW session and reports its id on `done`. If the
    // fallback still pointed at the transcript claude just abandoned, the next error would send the
    // conversation back to a dead session forever.
    harness.diskSessionId = "sess-dead";
    await startConciergeTurn("first");
    emit("concierge:done", { id: "turn-1", sessionId: "sess-healed", text: "hi" });
    expect(getConciergeSessionId()).toBe("sess-healed");
    emit("concierge:error", { id: "turn-2", detail: "claude exited with status 1" });
    expect(getConciergeSessionId()).toBe("sess-healed");
  });
});
