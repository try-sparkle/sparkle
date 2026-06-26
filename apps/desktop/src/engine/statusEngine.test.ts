import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusEngine } from "./statusEngine";
import type { AgentTabStatus } from "../types";

// Drives the engine and records the latest status, so each test can assert transitions.
// `getScreen` optionally supplies the rendered-screen snapshot the engine reads on settle
// to decide red (a question is on screen) vs gray (a finished turn).
function makeEngine(getScreen?: () => string) {
  const statuses: AgentTabStatus[] = [];
  const engine = new StatusEngine({
    agentId: "test",
    onStatus: (s) => statuses.push(s),
    getScreen,
  });
  return { engine, statuses, last: () => statuses[statuses.length - 1] };
}

// A rendered permission box (Claude's ❯ selection menu) and the idle input box, as the
// terminal snapshot would look on settle.
const PERMISSION_SCREEN = [
  "│ Do you want to make this edit to foo.ts?           │",
  "│ ❯ 1. Yes                                           │",
  "│   2. No, and tell Claude what to do differently    │",
].join("\n");
const IDLE_SCREEN = ["╭───────────────╮", "│ >             │", "╰───────────────╯"].join("\n");

describe("StatusEngine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts working and stays working while output flows", () => {
    const { engine, last } = makeEngine();
    expect(last()).toBe("working");
    engine.ingest("compiling module A\n");
    expect(last()).toBe("working");
  });

  it("goes idle after a quiet period, then blocked after a long stall", () => {
    const { engine, last } = makeEngine();
    engine.ingest("doing work\n");
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("idle");
    // blocked must still be reachable after idle (the bug roborev caught).
    vi.advanceTimersByTime(25000);
    expect(last()).toBe("blocked");
  });

  it("shows waiting when the agent asks a plain question", () => {
    const { engine, last } = makeEngine();
    engine.ingest("Do you want to proceed? (y/n)\n");
    expect(last()).toBe("waiting");
  });

  it("shows approval when a risky action precedes the prompt", () => {
    const { engine, last } = makeEngine();
    engine.ingest("$ git push origin main\n");
    // The real permission prompt is the ❯ selection menu, not bare prose.
    engine.ingest("❯ 1. Yes\n");
    expect(last()).toBe("approval");
  });

  it("ends done on a clean exit", () => {
    const { engine, last } = makeEngine();
    engine.ingest("All tasks complete.\n");
    engine.exit();
    expect(last()).toBe("done");
  });

  it("ends errored when an error is the last thing before exit", () => {
    const { engine, last } = makeEngine();
    engine.ingest("Error: cannot find module 'foo'\n");
    engine.exit();
    expect(last()).toBe("errored");
  });

  it("does NOT mislabel a recovered session as errored", () => {
    const { engine, last } = makeEngine();
    engine.ingest("Error: transient network blip\n");
    // Agent recovers and calmly waits for the user at a real prompt — error flag clears.
    engine.ingest("❯ 1. Yes\n");
    engine.exit();
    expect(last()).toBe("done");
  });

  it("does not treat a conversational 'Error:' mid-sentence as an error", () => {
    const { engine, last } = makeEngine();
    engine.ingest("I found the bug: the Error: prefix was matched too broadly.\n");
    engine.exit();
    expect(last()).toBe("done");
  });

  // --- Spinner-accurate detection (Claude Code's "esc to interrupt" status line) ---

  // A representative redraw of Claude Code's working status line.
  const SPINNER = "✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)";

  it("treats the working spinner as working", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
  });

  it("stays working through a long quiet tool run while the spinner keeps ticking", () => {
    const { engine, statuses, last } = makeEngine();
    // Simulate 30s of a slow tool: the spinner re-draws ~once a second but no other
    // output flows. The old time heuristic flipped this to idle then blocked — wrong.
    for (let i = 0; i < 30; i++) {
      engine.ingest(SPINNER);
      vi.advanceTimersByTime(1000);
    }
    expect(last()).toBe("working");
    expect(statuses).not.toContain("idle");
    expect(statuses).not.toContain("blocked");
  });

  it("settles to idle shortly after the spinner disappears (turn ended)", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
    // Spinner gone — Claude finished its turn and is waiting for you.
    vi.advanceTimersByTime(2000);
    expect(last()).toBe("idle");
  });

  it("settles to idle when the prompt box redraws after the spinner, not stuck working", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    // The idle input box redraws (no spinner, no question) right after work ends.
    engine.ingest("│ > \n");
    expect(last()).toBe("working"); // not yet — give it the settle window
    vi.advanceTimersByTime(2000);
    expect(last()).toBe("idle");
  });

  it("flips straight to waiting when a question interrupts spinner work", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
    engine.ingest("Do you want to proceed? (y/n)\n");
    expect(last()).toBe("waiting");
  });

  it("never emits blocked once the spinner has been seen", () => {
    const { engine, statuses } = makeEngine();
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(60000); // long past the legacy BLOCKED_MS
    expect(statuses).not.toContain("blocked");
  });

  // --- Settle-time RED/GRAY decision from the rendered screen snapshot ---

  it("turns waiting when the settled screen shows a question menu", () => {
    const { engine, last } = makeEngine(() => PERMISSION_SCREEN);
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
    // Spinner stops with a permission box on screen → Claude is blocked on you.
    vi.advanceTimersByTime(2000);
    expect(last()).toBe("waiting");
  });

  it("turns approval when a risky action preceded the on-screen question", () => {
    const { engine, last } = makeEngine(() => PERMISSION_SCREEN);
    engine.ingest("$ git push origin main\n");
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(2000);
    expect(last()).toBe("approval");
  });

  it("settles to idle (gray) when the screen shows only the idle input box", () => {
    const { engine, last } = makeEngine(() => IDLE_SCREEN);
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(2000);
    expect(last()).toBe("idle");
  });

  it("falls back to idle when no screen snapshot is available", () => {
    const { engine, last } = makeEngine(); // no getScreen
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(2000);
    expect(last()).toBe("idle");
  });

  it("does NOT flip to red when Claude writes a question as prose mid-turn", () => {
    // A think agent routinely ends a turn with "Do you want to proceed?" as chat
    // prose — a normal turn-end (gray), not a blocking TUI prompt (red). Mid-stream prose
    // must not force red; the settle screen-check is authoritative.
    const { engine, last } = makeEngine(() => IDLE_SCREEN);
    engine.ingest(SPINNER);
    engine.ingest("Do you want to proceed with the hybrid approach?\n");
    vi.advanceTimersByTime(2000);
    expect(last()).toBe("idle");
  });

  it("does not carry a risky action's flag past a non-blocking idle settle", () => {
    const { engine, last } = makeEngine(() => IDLE_SCREEN);
    // A risky action sets the risk flag, but the turn then ends with no on-screen
    // question (settles to idle). The flag must NOT leak into the next turn.
    engine.ingest("$ git push origin main\n");
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(2000);
    expect(last()).toBe("idle");
    // A later, unrelated benign question is a plain "waiting", not "approval".
    engine.ingest("Overwrite? (y/n)\n");
    expect(last()).toBe("waiting");
  });

  it("bounds the unterminated-line buffer instead of growing it all turn", () => {
    const { engine, last } = makeEngine();
    // The spinner redraws in place with no trailing newline. Simulate a long turn:
    // 1000 redraws (~50KB) that would otherwise accumulate unbounded in `partial`.
    for (let i = 0; i < 1000; i++) engine.ingest(SPINNER);
    expect(last()).toBe("working");
    expect((engine as unknown as { partial: string }).partial.length).toBeLessThanOrEqual(4096);
    // Detection still fires after the flood: a question on a completed line wins.
    engine.ingest("Do you want to proceed? (y/n)\n");
    expect(last()).toBe("waiting");
  });
});
