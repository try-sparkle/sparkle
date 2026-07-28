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
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    harness.invokes.push({ cmd, args });
    if (cmd === "concierge_session_info") {
      if (harness.gateProbe) await harness.gateProbe();
      if (harness.probeFails) throw new Error("no app data dir");
      return { hasSession: harness.diskSessionId !== null, latestSessionId: harness.diskSessionId };
    }
    if (cmd === "concierge_turn") return "turn-1";
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
  resetConciergeSession,
  restoreConciergeSession,
  setConciergeSessionId,
  startConciergeTurn,
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
