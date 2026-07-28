// The frontend half of the PROACTIVE PUSH transport (PRD/sparkle/concierge-proactive-push.md).
//
// Its own file rather than more cases in concierge.test.ts: this is a distinct contract — a turn
// nobody asked for — and its defining property is that it is SILENT when it can't run. A refused
// push is the channel working correctly, so nothing about it may ever reach the thread.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";

type Handler = (ev: { payload: unknown }) => void;
const harness = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  invokes: [] as Array<{ cmd: string; args: unknown }>,
  invokeImpl: undefined as ((cmd: string) => Promise<unknown> | undefined) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: unknown) => {
    harness.invokes.push({ cmd, args });
    return harness.invokeImpl?.(cmd) ?? Promise.resolve();
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
  isProactiveDeclinedDetail,
  isProactiveTurn,
  onConciergeDone,
  onConciergeError,
  PROACTIVE_DECLINED_DETAIL,
  PROACTIVE_TURN_MEMORY,
  startConciergeTurn,
  startProactiveConciergeTurn,
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

function pushArgs(n: number): { prompt: string; resumeSessionId: string | null } {
  const call = harness.invokes.filter((c) => c.cmd === "concierge_proactive_turn").at(n);
  if (!call) throw new Error(`expected a concierge_proactive_turn invoke #${n}`);
  return call.args as { prompt: string; resumeSessionId: string | null };
}

describe("startProactiveConciergeTurn", () => {
  beforeEach(() => {
    openConciergeAiGate();
    harness.handlers.clear();
    harness.invokes.length = 0;
    harness.invokeImpl = undefined;
    _resetConciergeForTests();
  });

  it("invokes the PROACTIVE command, not the send command", async () => {
    // A push must never travel down `concierge_turn`: that path publishes a retirement floor and
    // would silence whatever the user is waiting on.
    harness.invokeImpl = (cmd) =>
      cmd === "concierge_proactive_turn" ? Promise.resolve("7") : undefined;
    await expect(startProactiveConciergeTurn("3 need you")).resolves.toBe("7");
    expect(harness.invokes.some((c) => c.cmd === "concierge_turn")).toBe(false);
    expect(pushArgs(0).prompt).toBe("3 need you");
  });

  it("rides the SAME ongoing session as the user's conversation", async () => {
    // Continuity both ways: the push sees what the user has been saying, and the user's next turn
    // remembers what the concierge volunteered. A separate session would fork the conversation and
    // pay for the context twice.
    harness.invokeImpl = (cmd) => (cmd === "concierge_turn" ? Promise.resolve("1") : undefined);
    await startConciergeTurn("hello");
    harness.handlers.get("concierge:done")?.({
      payload: { id: "1", sessionId: "sess-A", text: "hi" },
    });
    await startProactiveConciergeTurn("2 need you");
    expect(pushArgs(0).resumeSessionId).toBe("sess-A");
  });

  it("stays SILENT when the push is declined — nobody asked for it", async () => {
    const seen: string[] = [];
    onConciergeError((e) => seen.push(e.detail));
    harness.invokeImpl = (cmd) =>
      cmd === "concierge_proactive_turn"
        ? Promise.reject(new Error(PROACTIVE_DECLINED_DETAIL))
        : undefined;
    await expect(startProactiveConciergeTurn("x")).resolves.toBeNull();
    expect(seen).toEqual([]);
  });

  it("stays silent on ANY failure, including a broken bridge", async () => {
    // The send path synthesizes a local error event so the column can say "I couldn't reach my
    // brain" — correct there, because the user is waiting on an answer. Here it would post an
    // apology for a message the user never requested.
    const seen: string[] = [];
    onConciergeError((e) => seen.push(e.detail));
    harness.invokeImpl = (cmd) =>
      cmd === "concierge_proactive_turn" ? Promise.reject(new Error("no bridge")) : undefined;
    await expect(startProactiveConciergeTurn("x")).resolves.toBeNull();
    expect(seen).toEqual([]);
  });

  it("pins the declined sentinel Rust emits, so the two languages can't drift apart", () => {
    // The mirror of concierge.rs's `the_declined_push_sentinel_is_the_string_the_frontend_matches`.
    // Both literal assertions are the whole guard — neither may be deleted as duplication.
    expect(PROACTIVE_DECLINED_DETAIL).toBe(
      "concierge_proactive_turn: declined; the user owns the conversation",
    );
    expect(isProactiveDeclinedDetail(`Error: ${PROACTIVE_DECLINED_DETAIL}`)).toBe(true);
    expect(isProactiveDeclinedDetail("concierge_turn: cancelled")).toBe(false);
  });

  it("refuses an empty prompt without touching the bridge", async () => {
    await expect(startProactiveConciergeTurn("   ")).resolves.toBeNull();
    expect(harness.invokes).toEqual([]);
  });
});

// ── A PUSH THAT FAILS AFTER SPAWNING (roborev 54166-M3) ────────────────────────────────────────
// The "silent on every failure" contract was only enforced on the INVOKE-REJECTION path. A push
// that got as far as spawning and then died — a claude error, a stale `--resume` the Rust side
// already retried once — reports on the SHARED `concierge:error` channel with a real detail, and
// nothing in that payload says which command produced it. So the service listener rolled back the
// user's live session pointer for a turn nobody asked for, and every `onConciergeError` subscriber
// (the host among them) rendered "I couldn't reach my brain just now" for a message the user never
// requested. The transport is Rust's and cannot be re-tagged from here, so this side remembers
// which turn ids it opened.
describe("a push's own failure never reaches the user", () => {
  beforeEach(() => {
    harness.handlers.clear();
    harness.invokes.length = 0;
    harness.invokeImpl = undefined;
    _resetConciergeForTests();
  });

  /** Get the user's conversation into a state where a rollback is OBSERVABLE: `currentSessionId`
   *  is an explicit override (sess-B) while the recoverable fallback is still sess-A. */
  async function divergedSession(): Promise<void> {
    harness.invokeImpl = (cmd) => (cmd === "concierge_turn" ? Promise.resolve("1") : undefined);
    await startConciergeTurn("hello");
    harness.handlers.get("concierge:done")?.({
      payload: { id: "1", sessionId: "sess-A", text: "hi" },
    });
    await startConciergeTurn("again", "sess-B");
    expect(getConciergeSessionId()).toBe("sess-B");
  }

  it("does not post an apology for a message the user never asked for", async () => {
    const seen: string[] = [];
    onConciergeError((e) => seen.push(e.detail));
    harness.invokeImpl = (cmd) =>
      cmd === "concierge_proactive_turn" ? Promise.resolve("9") : undefined;
    await startProactiveConciergeTurn("2 need you");
    harness.handlers.get("concierge:error")?.({
      payload: { id: "9", detail: "claude exited with status 1" },
    });
    expect(seen).toEqual([]);
  });

  it("does not roll the user's live conversation pointer back", async () => {
    await divergedSession();
    harness.invokeImpl = (cmd) =>
      cmd === "concierge_proactive_turn" ? Promise.resolve("9") : undefined;
    await startProactiveConciergeTurn("2 need you");
    harness.handlers.get("concierge:error")?.({
      payload: { id: "9", detail: "claude exited with status 1" },
    });
    expect(getConciergeSessionId(), "a push cannot rewrite where the user's next turn resumes").toBe(
      "sess-B",
    );
  });

  it("leaves a SEND's failure fully intact — both the apology and the rollback", async () => {
    // The guard against over-filtering. This channel's silence must be scoped to pushes; a send
    // that fails is a user waiting on an answer, and they get told.
    await divergedSession();
    const seen: string[] = [];
    onConciergeError((e) => seen.push(e.detail));
    harness.handlers.get("concierge:error")?.({
      payload: { id: "2", detail: "claude exited with status 1" },
    });
    expect(seen).toEqual(["claude exited with status 1"]);
    expect(getConciergeSessionId()).toBe("sess-A");
  });

  it("tags a push's turn id so the thread can render it as a push, not a reply", async () => {
    // The other half of the same problem: a push's `done` must be distinguishable, or it lands as
    // an ordinary sparkle bubble with no digest — an append-only "You have 3 P1s" with no way to
    // ever retract it (PRD §2a).
    const done: string[] = [];
    onConciergeDone((e) => done.push(e.id));
    harness.invokeImpl = (cmd) =>
      cmd === "concierge_proactive_turn" ? Promise.resolve("9") : undefined;
    await startProactiveConciergeTurn("2 need you");
    expect(isProactiveTurn("9")).toBe(true);
    expect(isProactiveTurn("1"), "a send is not a push").toBe(false);
    harness.handlers.get("concierge:done")?.({
      payload: { id: "9", sessionId: "sess-A", text: "Kraken Auth is blocked." },
    });
    // A push's `done` DOES fan out — it is the message itself, and the thread has to render it.
    expect(done).toEqual(["9"]);
    // …and it stays recognisable afterwards, because the host stamps the bubble on `done`.
    expect(isProactiveTurn("9")).toBe(true);
  });

  it("remembers a BOUNDED number of push ids, so the set cannot grow for the session", async () => {
    harness.invokeImpl = undefined;
    for (let i = 0; i < PROACTIVE_TURN_MEMORY + 5; i++) {
      const id = String(i);
      harness.invokeImpl = (cmd) =>
        cmd === "concierge_proactive_turn" ? Promise.resolve(id) : undefined;
      await startProactiveConciergeTurn(`push ${i}`);
    }
    expect(isProactiveTurn(String(PROACTIVE_TURN_MEMORY + 4)), "the newest is remembered").toBe(
      true,
    );
    expect(isProactiveTurn("0"), "the oldest has aged out").toBe(false);
  });
});
