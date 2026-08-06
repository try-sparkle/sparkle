import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  StatusEngine,
  parseSpinnerTokens,
  latestSpinnerTokens,
  isSpinnerFrame,
  onSessionLimitPicker,
  SESSION_LIMIT_PICKER_EVENT,
  type SessionLimitPickerDetail,
} from "./statusEngine";
import { createStatusRouter, type StatusTransition } from "./statusRouter";
import { SESSION_LIMIT_PICKER, APPROVAL_2_1_220 } from "./capturedScreens.fixture";
// The SAME predicate the concierge tool surface derives `needsYou` from, so the no-false-alarm
// tests below assert the tier the human is actually paged on rather than a status name.
import { isRedStatus } from "../services/windowStatus";
import type { AgentTabStatus } from "../types";
// The LOGGER, not `console`: logger.ts binds its `realConsole` at module load, so a console spy
// installed later never sees the line and the transition tests below would pass vacuously against
// silent code — the exact failure they exist to prevent.
import { log } from "../logger";
import { STATUS_TRANSITION_MARKER } from "./statusTransitionLog";

// Every transition now emits a log line, so spy for the WHOLE file: the transition suite reads the
// calls, and every other suite gets a quiet console instead of a line per flip.
const spyLog = () => vi.spyOn(log, "info").mockImplementation(() => {});
let logInfo: ReturnType<typeof spyLog>;
beforeEach(() => {
  logInfo = spyLog();
});
afterEach(() => logInfo.mockRestore());

/** The status-transition lines emitted so far, in order — i.e. what `grep agent-status` would show. */
function transitionLines(): string[] {
  return logInfo.mock.calls
    .map((args) => String(args[1] ?? ""))
    .filter((line) => line.startsWith(STATUS_TRANSITION_MARKER));
}

describe("parseSpinnerTokens", () => {
  it("parses k-suffixed and bare token counts from a spinner frame", () => {
    expect(parseSpinnerTokens("✻ Incubating… (1m 24s · ↓ 2.1k tokens · esc to interrupt)")).toBe(2100);
    expect(parseSpinnerTokens("✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)")).toBe(1200);
    expect(parseSpinnerTokens("✻ Working… (3s · ↑ 500 tokens · esc to interrupt)")).toBe(500);
    expect(parseSpinnerTokens("✻ Working… (9s · ↓ 12.3k tokens · esc to interrupt)")).toBe(12300);
  });

  it("scales an m-suffixed count so a long turn keeps ordering with k-suffixed frames", () => {
    // Without the suffix table "1.2m" parsed as 1.2 — i.e. a huge count read as SMALLER than the
    // preceding "900k" frame, which silently stalls the advance comparison for the rest of the turn.
    expect(parseSpinnerTokens("✻ Working… (4m 2s · ↓ 1.2m tokens · esc to interrupt)")).toBe(1_200_000);
    expect(parseSpinnerTokens("✻ Working… (4m 2s · ↓ 1.2M tokens · esc to interrupt)")).toBe(1_200_000);
    expect(parseSpinnerTokens("✻ Working… (3m · ↓ 900k tokens · esc to interrupt)")).toBe(900_000);
  });

  it("returns null when the frame carries no token figure", () => {
    expect(parseSpinnerTokens("✻ Cogitating… (12s · esc to interrupt)")).toBeNull();
    expect(parseSpinnerTokens("compiling module A")).toBeNull();
  });

  it("never returns NaN on a malformed or unknown-suffix figure", () => {
    // A NaN would pass the `!== null` check and then compare false in EVERY advance test, silently
    // disabling the recovery instead of failing loudly.
    // Leading punctuation is skipped rather than parsed into NaN — "..5" reads as the 5 it contains.
    expect(parseSpinnerTokens("✻ Working… (3s · ↑ ..5 tokens · esc to interrupt)")).toBe(5);
    // A malformed "1.2.3k" resolves to the well-formed figure that actually abuts "tokens" (2.3k),
    // because that is the only substring the pattern can match end-to-end. Never NaN.
    expect(parseSpinnerTokens("✻ Working… (3s · ↑ 1.2.3k tokens · esc to interrupt)")).toBe(2300);
    // An unknown suffix doesn't parse at all — null, i.e. "the token signal doesn't apply", which is
    // the safe direction (no baseline update, no clear). The `?? 1` scale fallback in
    // parseSpinnerTokens is the belt-and-braces for a future widening of the suffix class.
    expect(parseSpinnerTokens("✻ Working… (3s · ↑ 12g tokens · esc to interrupt)")).toBeNull();
  });
});

describe("latestSpinnerTokens", () => {
  it("reads the NEWEST redraw in a multi-frame chunk, not a stale earlier one", () => {
    const chunk =
      "✻ Working… (1s · ↑ 100 tokens · esc to interrupt)\r" +
      "✻ Working… (2s · ↑ 200 tokens · esc to interrupt)\r" +
      "✻ Working… (3s · ↑ 300 tokens · esc to interrupt)";
    expect(latestSpinnerTokens(chunk)).toBe(300);
  });

  it("walks back past figure-less redraws to the newest frame that HAS a count", () => {
    // Claude drops the counter from some redraws. Reading only the newest marker frame would return
    // null here and skip both the comparison and the baseline update for the whole chunk.
    const chunk =
      "✻ Working… (2s · ↑ 200 tokens · esc to interrupt)\r" +
      "✻ Working… (3s · esc to interrupt)\r" +
      "✻ Working… (4s · esc to interrupt)";
    expect(latestSpinnerTokens(chunk)).toBe(200);
  });

  it("still prefers the NEWEST frame that carries a count, and ignores prose", () => {
    const chunk =
      "compacted 30k tokens\n" +
      "✻ Working… (2s · ↑ 200 tokens · esc to interrupt)\r" +
      "✻ Working… (3s · ↑ 300 tokens · esc to interrupt)";
    expect(latestSpinnerTokens(chunk)).toBe(300);
    expect(latestSpinnerTokens("compacted 30k tokens\nno spinner here")).toBeNull();
  });
});

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

  it("goes idle after a quiet period and STAYS there — silence is not a needs-you", () => {
    const { engine, statuses, last } = makeEngine(() => IDLE_SCREEN);
    engine.ingest("doing work\n");
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("idle");
    // This used to escalate to `blocked` here — red, captioned "Blocked / stalled — needs you",
    // and pushed to the human as a needs-you card — purely because the terminal had gone quiet for
    // 25s. The screen said the opposite (an idle prompt, no question) both at settle and now.
    vi.advanceTimersByTime(25000);
    expect(last()).toBe("idle");
    expect(statuses).not.toContain("blocked");
    // Well past the old escalation, in case a future timer is added on the same silence signal.
    vi.advanceTimersByTime(120_000);
    expect(statuses.filter(isRedStatus)).toEqual([]);
  });

  it("never reports needsYou while a long shell command runs quietly", () => {
    // The founder-reported repro (2026-07-28): an agent mid-`pnpm test` / `roborev wait` emits
    // nothing for minutes. `needsYou` on the concierge tool surface is exactly isRedStatus(status)
    // (conciergeTools/terminal.getAgentStatus), so asserting the red TIER — not one status name —
    // is what pins the contract the human actually reads.
    const { engine, statuses } = makeEngine(() => IDLE_SCREEN);
    engine.ingest("$ pnpm test\n");
    for (let i = 0; i < 12; i++) vi.advanceTimersByTime(30_000); // 6 minutes of silence
    expect(statuses.filter(isRedStatus)).toEqual([]);
    // …and the run finishing is still just a finished turn, not an alarm.
    engine.ingest("Test Files  518 passed\n");
    vi.advanceTimersByTime(2500);
    expect(statuses.filter(isRedStatus)).toEqual([]);
  });

  it("keeps the approval SUBTYPE on a late-painting dangerous-action prompt", () => {
    // roborev on 95013a2f1: settle consumes `sawRecentRisk`, so reading that flag 22.5s later made
    // the re-check's `approval` branch unreachable — a permission box that painted late would be
    // labeled a plain question for every alert/suggestion surface downstream.
    let screen = IDLE_SCREEN;
    const { engine, last } = makeEngine(() => screen);
    engine.ingest("Bash(rm -rf build/)\n"); // classifies as approval_needed → arms the risk flag
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("idle");
    screen = PERMISSION_SCREEN;
    vi.advanceTimersByTime(25000);
    expect(last()).toBe("approval");
  });

  it("catches a prompt that only PAINTS after settle, on the late screen re-check", () => {
    // xterm renders asynchronously, so a picker that streamed in just before the settle timer can
    // reach the grid after settle read it. That race is the one thing the old 25s timer was doing
    // that was worth keeping — now done by re-reading the screen instead of assuming the worst.
    let screen = IDLE_SCREEN;
    const { engine, last } = makeEngine(() => screen);
    engine.ingest("thinking about it\n");
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("idle");
    screen = PERMISSION_SCREEN; // the menu finally paints
    vi.advanceTimersByTime(25000);
    expect(last()).toBe("waiting");
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

  // TUI DRIFT (2026-07-28). Claude Code moved "esc to interrupt" OFF the live status line and into
  // the persistent footer hint bar. Every fixture above still carries the old fused shape, which is
  // why a green suite said nothing while working agents rendered GRAY in the app: the marker was the
  // ONLY working signal, so ~2s into every turn the settle timer fired and recorded `idle`. That one
  // fault also opened the CTA gate mid-turn (`idle` is in useSuggestions' YOUR_TURN set) and pinned
  // `isInMotion` false, which in turn removed the in-motion suppression on the worker-red bubble.
  //
  // Both shapes must read as working, and the footer must NOT — it is chrome that is on screen for
  // the whole session, so treating it as proof of a running turn would pin every agent green forever
  // (the mirror-image bug, and the more dangerous one: a false green hides a real question).
  const TODAY_SPINNER = "✢ Metamorphosing… (40m 17s · ↓ 66.9k tokens)";
  const FOOTER_HINT = "▶▶ bypass permissions on (shift+tab to cycle) · PR #730 · esc to interrupt";

  it("recognises BOTH status-line shapes, and refuses the footer bar", () => {
    // The predicate directly, because it is the whole of the change and the engine-level tests
    // below can be satisfied by the legacy any-output fallback rather than by spinner mode.
    expect(isSpinnerFrame(TODAY_SPINNER)).toBe(true);
    expect(isSpinnerFrame(SPINNER)).toBe(true); // legacy shape still works
    expect(isSpinnerFrame("✻ Working… (3m · ↓ 900k tokens)")).toBe(true);
    // The footer is drawn whether or not a turn is running, so it can never mean "working" —
    // and it carries the legacy hint, which is exactly why a whole-chunk match was unsafe.
    expect(isSpinnerFrame(FOOTER_HINT)).toBe(false);
    // Prose that merely mentions a duration or a token count is not a status line.
    expect(isSpinnerFrame("compacted 30k tokens")).toBe(false);
    expect(isSpinnerFrame("the build took 12s")).toBe(false);
    // A glyph-led line with no clock and no counter is not one either.
    expect(isSpinnerFrame("* a markdown bullet")).toBe(false);
  });

  it("stays working on today's status line once spinner mode is latched (the gray-dot bug)", () => {
    // THE REPRODUCTION. Ingesting today's line into a fresh engine proves little: with the spinner
    // never latched it falls through to the LEGACY output-flow heuristic (case 4), which reports
    // `working` for any output at all, so the drift hides there. It bites once `sawSpinner` is set —
    // from then on ONLY a marker frame re-arms the settle timer, so a status line that redraws every
    // second without matching leaves the turn recorded `idle` 2s in, while the agent is plainly
    // running. That is the gray dot on a working agent, and the open CTA gate behind it.
    const { engine, statuses, last } = makeEngine(() => IDLE_SCREEN);
    engine.ingest(SPINNER); // latch spinner mode on the shape we already matched
    for (let i = 0; i < 30; i++) {
      engine.ingest(`✢ Metamorphosing… (${40 + i}m 17s · ↓ 66.9k tokens)`);
      vi.advanceTimersByTime(1000);
    }
    expect(last()).toBe("working");
    expect(statuses).not.toContain("idle");
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

  // --- Mid-stream failure / stall detection (sparkle-pqxh): RED while the process stays alive ---

  it("goes errored when a mid-stream API error prints, OVERRIDING the still-ticking spinner", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
    // The agent prints the API banner (its own line) but keeps its PTY alive (no exit) and the
    // spinner keeps ticking — the exact case that used to read green forever.
    engine.ingest(
      "\nAPI Error: Server is temporarily limiting requests (not your usage limit) · Rate limited\n",
    );
    expect(last()).toBe("errored");
    // A later spinner tick must NOT pull it back to green — the failure is sticky until real progress.
    engine.ingest(SPINNER);
    expect(last()).toBe("errored");
  });

  it("catches an API banner fused onto a spinner carriage-return redraw", () => {
    const { engine, last } = makeEngine();
    // The spinner redraws with \r (no newline); the banner streams onto the tail of the same line.
    engine.ingest(SPINNER + "\rAPI Error: Rate limited\n");
    expect(last()).toBe("errored");
  });

  // END-TO-END FOR THE MARKER FIX (sparkle-onzu, roborev 55416). The banner does not arrive bare:
  // Claude Code records an API failure as a synthetic ASSISTANT message and the TUI prefixes those
  // with "⏺ ", so every real 529 read GREEN until the anchor learned to strip it. Asserted at THIS
  // level, not just on the pure matcher, because the shape that actually reaches a live agent is a
  // banner in an UNTERMINATED tail — caught only by the partial-tail arrival diff, never by the
  // completed-line loop.
  it("goes errored on a ⏺-prefixed banner with NO trailing newline (the live shape)", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
    // No trailing "\n" — this is the whole point. Verbatim the founder's screenshot.
    engine.ingest("\r⏺ API Error: 529 Overloaded.");
    expect(last()).toBe("errored");
    engine.ingest(SPINNER);
    expect(last()).toBe("errored"); // sticky until real progress
  });

  it("goes errored on a ⏺-prefixed banner as a completed line too", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest("\n⏺ API Error: 500 Internal server error.\n");
    expect(last()).toBe("errored");
  });

  // The counterpart guard: a command's OUTPUT that merely reads like a banner must not paint the row
  // red. `⎿` is the tool-RESULT marker, so this is an agent curling a failing endpoint or tailing a
  // log — healthy work. Including `⎿` in the marker class would have reintroduced exactly the
  // "logs the agent is reading" false-red this module deliberately avoids.
  it("stays working when a TOOL RESULT contains an API-error-looking line", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
    engine.ingest("\n  ⎿  API Error: 500 Internal server error.\n");
    expect(last()).toBe("working");
    engine.ingest("\n  ⎿  API Error: 429 rate_limit_error\n");
    expect(last()).toBe("working");
  });

  // ⚠️ PINNING A KNOWN RESIDUAL, at the level where it actually bites (roborev 55467).
  //
  // The test above closes the result-HEAD case only. The TUI marks just the FIRST line of a tool
  // result with `⎿`; continuation lines are plain indented text, and this engine trims leading
  // whitespace before anchoring — so line 2+ of a multi-line result that begins "API Error: …" DOES
  // paint a healthy agent red. streamFailure.test.ts pins this on the matcher, where it is arguably
  // by design; the harm is here, so the assertion belongs here too.
  //
  // THIS TEST ASSERTS THE BUG. If you close the residual — tool-result-block tracking, as
  // streamFailure's header proposes — this goes red and points you at that rationale. Flip it to
  // "working" then; do not delete it.
  it("STILL goes errored on an UNMARKED continuation line of a tool result (known residual)", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
    // A two-line result: the head wears `⎿`, the body does not. Think `curl` printing a status line
    // and then a JSON error, or a tailed log.
    engine.ingest("\n  ⎿  $ curl -sS https://example.test/v1\n     API Error: 500 Internal server error.\n");
    expect(last()).toBe("errored");
  });

  it("goes errored on a self-prompt loop (REPEATED pings) instead of staying working forever", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
    // Bug A: a SINGLE self-ping is no longer a wedge (it could be the user, or a prose quote), so the
    // wedge signal is the phrase REPEATING with no progress. Each ping is its own completed line.
    engine.ingest("Are you there?\n");
    expect(last()).toBe("working"); // one ping — not yet a loop
    engine.ingest("Hey, Sparkler. Are you there?\n"); // the loop repeats → wedge
    expect(last()).toBe("errored");
    engine.ingest(SPINNER);
    expect(last()).toBe("errored");
  });

  it("goes errored on an identical-short-line churn loop", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    // A newline ends the in-place spinner redraw, then the same short line repeats with no progress
    // (>= STALL_REPEAT_THRESHOLD identical short lines).
    engine.ingest("\n…\n…\n…\n…\n…\n");
    expect(last()).toBe("errored");
  });

  it("recovers to working when real tool activity resumes after a stream failure", () => {
    const { engine, last } = makeEngine();
    engine.ingest("API Error: Rate limited\n");
    expect(last()).toBe("errored");
    // The retry succeeds and the agent does real work again (a classified file event + spinner).
    engine.ingest("Reading file src/foo.ts\n" + SPINNER);
    expect(last()).toBe("working");
  });

  it("recovers to working when the spinner's token counter ADVANCES after a blip", () => {
    // The founder-reported false-red: a HEALTHY agent hits a transient API blip early in a long
    // turn, then keeps GENERATING (the "Incubating… ↓ 2.1k tokens" spinner climbing) with no tool
    // event yet. An advancing token count is positive proof of forward progress, so the sticky
    // failure must clear even without a classified tool line.
    const { engine, last } = makeEngine();
    engine.ingest("✻ Incubating… (30s · ↓ 1.0k tokens · esc to interrupt)"); // baseline 1.0k
    expect(last()).toBe("working");
    engine.ingest("\nAPI Error: overloaded\n");
    expect(last()).toBe("errored");
    // Generation resumes — the next frame's count is strictly higher than the last we saw.
    engine.ingest("✻ Incubating… (1m 24s · ↓ 2.1k tokens · esc to interrupt)");
    expect(last()).toBe("working");
  });

  it("does NOT recover on a FROZEN token counter (a wedged agent's spinner still ticks)", () => {
    // The wedge sparkle-pqxh targets: the spinner keeps redrawing (elapsed time even advances) but
    // the token count is STUCK, because nothing is being generated. A repeated count must stay red.
    const { engine, last } = makeEngine();
    engine.ingest("✻ Incubating… (30s · ↓ 2.1k tokens · esc to interrupt)"); // baseline 2.1k
    engine.ingest("\nAPI Error: overloaded\n");
    expect(last()).toBe("errored");
    engine.ingest("✻ Incubating… (31s · ↓ 2.1k tokens · esc to interrupt)"); // same count, later clock
    engine.ingest("✻ Incubating… (32s · ↓ 2.1k tokens · esc to interrupt)"); // still same
    expect(last()).toBe("errored");
  });

  it("does NOT let an advancing counter clear a churn wedge tripping in the SAME chunk", () => {
    // A churn chunk that ALSO carries a higher spinner must not self-clear: the repeated bad lines
    // re-arm red in the same chunk, and the trippedThisChunk guard suppresses the token recovery.
    const { engine, last } = makeEngine();
    engine.ingest("✻ Cogitating… (10s · ↑ 1.0k tokens · esc to interrupt)"); // baseline 1.0k
    expect(last()).toBe("working");
    // One chunk: >= STALL_REPEAT_THRESHOLD (5) identical short completed lines (trips churn) followed
    // by a spinner whose token count jumped to 5.0k. The guard must keep it red despite 5.0k > 1.0k.
    engine.ingest("\n…\n…\n…\n…\n…\n✻ Cogitating… (15s · ↑ 5.0k tokens · esc to interrupt)");
    expect(last()).toBe("errored");
  });

  it("does NOT let an advancing counter clear a churn wedge tripped in an EARLIER chunk", () => {
    // The `trippedThisChunk` guard alone only covers the chunk the churn landed in. A wedged agent
    // GENERATES its own churn, so its token counter climbs — the next spinner-only chunk would
    // otherwise clear the very wedge sparkle-pqxh exists to catch, flapping the row red↔green.
    const { engine, last } = makeEngine();
    engine.ingest("✻ Cogitating… (10s · ↑ 1.0k tokens · esc to interrupt)"); // baseline 1.0k
    expect(last()).toBe("working");
    engine.ingest("\n…\n…\n…\n…\n…\n"); // churn trips, no spinner in this chunk
    expect(last()).toBe("errored");
    // A LATER chunk carrying only a much higher spinner count must NOT clear a churn wedge.
    engine.ingest("✻ Cogitating… (15s · ↑ 5.0k tokens · esc to interrupt)");
    expect(last()).toBe("errored");
    engine.ingest("✻ Cogitating… (20s · ↑ 9.0k tokens · esc to interrupt)");
    expect(last()).toBe("errored");
  });

  it("does NOT let an advancing counter clear a SELF-PROMPT wedge", () => {
    // The canonical pqxh wedge: the agent pings itself in a loop. It is generating those pings, so
    // the counter climbs the whole time — token progress must carry no weight here.
    const { engine, last } = makeEngine();
    engine.ingest("✻ Cogitating… (10s · ↑ 1.0k tokens · esc to interrupt)");
    engine.ingest("\nAre you there?\nAre you there?\n"); // >= SELF_PROMPT_REPEAT_THRESHOLD
    expect(last()).toBe("errored");
    engine.ingest("✻ Cogitating… (20s · ↑ 4.0k tokens · esc to interrupt)");
    expect(last()).toBe("errored");
  });

  it("does NOT read a token figure from PROSE that shares a chunk with the spinner", () => {
    // Guard (d): the figure is taken from the newest spinner FRAME, not the first "N tokens" match in
    // the chunk. Otherwise a line like "compacted 30k tokens" reads as the counter and force-greens a
    // still-blipped agent whose real counter is frozen.
    const { engine, last } = makeEngine();
    engine.ingest("✻ Incubating… (30s · ↓ 2.1k tokens · esc to interrupt)"); // baseline 2.1k
    engine.ingest("\nAPI Error: overloaded\n");
    expect(last()).toBe("errored");
    // Prose mentioning a much larger figure, plus a spinner whose real count has NOT moved.
    engine.ingest("compacted 30k tokens\n✻ Incubating… (31s · ↓ 2.1k tokens · esc to interrupt)");
    expect(last()).toBe("errored");
  });

  it("does NOT carry a PREVIOUS turn's token baseline into the next turn", () => {
    // Claude's spinner counter is per-turn and restarts low. A stale high-water mark from a short
    // previous turn (100 tokens) would make the FIRST frozen frame of a wedged new turn (5.0k) read
    // as an advance and force a false green — so the baseline must be dropped when the turn settles.
    const { engine, last } = makeEngine(() => IDLE_SCREEN);
    engine.ingest("✻ Working… (5s · ↑ 100 tokens · esc to interrupt)");
    expect(last()).toBe("working");
    vi.advanceTimersByTime(2000); // spinner stops -> settle -> turn over
    expect(last()).toBe("idle");
    // New turn: it blips immediately and its counter is FROZEN at 5.0k (a rate-limit retry loop).
    engine.ingest("\nAPI Error: overloaded\n");
    expect(last()).toBe("errored");
    engine.ingest("✻ Working… (8s · ↓ 5.0k tokens · esc to interrupt)"); // first frame of the new turn
    expect(last()).toBe("errored");
    engine.ingest("✻ Working… (9s · ↓ 5.0k tokens · esc to interrupt)"); // still frozen
    expect(last()).toBe("errored");
  });

  it("does NOT clear when a FRESH banner rides in the partial of the same advancing chunk", () => {
    // The partial-buffer banner check used to be gated on `!sawStreamFailure`, so a NEW banner
    // arriving while a failure was already latched didn't re-arm the chunk guard — and the advancing
    // spinner in that same chunk cleared the red it had just re-observed.
    const { engine, last } = makeEngine();
    engine.ingest("✻ Incubating… (30s · ↓ 1.0k tokens · esc to interrupt)"); // baseline 1.0k
    engine.ingest("\nAPI Error: 529 overloaded_error\n");
    expect(last()).toBe("errored");
    // One chunk: a DIFFERENT banner still unterminated (no trailing \n) fused onto a higher spinner.
    engine.ingest("\n✻ Incubating… (40s · ↓ 3.0k tokens · esc to interrupt)\rAPI Error: 500 Internal server error");
    expect(last()).toBe("errored");
  });

  it("does NOT let a banner LINGERING in the partial block recovery forever", () => {
    // The other side of that guard: the spinner redraws with \r, so an unterminated banner can sit in
    // the partial for the rest of the turn. Re-arming on every chunk that still shows it would pin the
    // row red for good — the original false-red. Only a banner that ARRIVED in this chunk's tail
    // re-arms; one already carried in from a prior chunk (`base`) is diffed out.
    const { engine, last } = makeEngine();
    engine.ingest("✻ Incubating… (30s · ↓ 1.0k tokens · esc to interrupt)");
    engine.ingest("\nAPI Error: 529 overloaded_error"); // unterminated: stays in the partial
    expect(last()).toBe("errored");
    // Same banner still trailing the partial, but the counter is climbing again -> generating.
    engine.ingest("\r✻ Incubating… (40s · ↓ 2.0k tokens · esc to interrupt)");
    engine.ingest("\r✻ Incubating… (41s · ↓ 2.4k tokens · esc to interrupt)");
    expect(last()).toBe("working");
  });

  it("re-trips when the SAME banner text is re-emitted into the partial after a clear", () => {
    // The shape that text-identity alone gets wrong (roborev 46899): a rate-limit retry loop repeats
    // ONE banner verbatim. Occurrence COUNT is what separates "a second banner arrived" from "the
    // first one is still sitting in the unterminated partial", and getting it wrong here is
    // fail-OPEN — the row stays green through a live API failure.
    const BANNER = "API Error: 500 Internal server error";
    const { engine, last } = makeEngine();
    engine.ingest("✻ Working… (30s · ↓ 1.0k tokens · esc to interrupt)");
    engine.ingest("\r" + BANNER); // unterminated: lives in the partial
    expect(last()).toBe("errored");
    engine.ingest("\r✻ Working… (40s · ↓ 2.0k tokens · esc to interrupt)"); // generating -> clears
    expect(last()).toBe("working");
    engine.ingest("\r" + BANNER); // a SECOND, identical banner — must trip again
    expect(last()).toBe("errored");
  });

  it("re-trips on a repeated banner even once the partial has saturated past MAX_PARTIAL", () => {
    // Counting banners in the WHOLE partial fails here: past MAX_PARTIAL (4096) every chunk evicts as
    // much off the front as it appends, so the chunk that delivers a new identical banner can also
    // evict the old one — count unchanged, text unchanged, no trip (roborev 46920). Measuring what
    // ARRIVED in the chunk is immune, because the buffer is never rescanned.
    const BANNER = "API Error: 500 Internal server error";
    const { engine, last } = makeEngine();
    // ~90 redraws with no newline: the unterminated buffer is well past MAX_PARTIAL.
    for (let i = 0; i < 90; i++) engine.ingest(`\r✻ Working… (${i}s · ↓ 1.0k tokens · esc to interrupt)`);
    expect(last()).toBe("working");
    engine.ingest("\r" + BANNER);
    expect(last()).toBe("errored");
    engine.ingest("\r✻ Working… (91s · ↓ 2.0k tokens · esc to interrupt)"); // generating -> clears
    expect(last()).toBe("working");
    engine.ingest("\r" + BANNER); // identical banner, saturated buffer — must still trip
    expect(last()).toBe("errored");
  });

  it("re-reddens when a cleared banner is finally FLUSHED as a completed line", () => {
    // Pinning deliberate (if slightly noisy) behavior: a banner that was tripped in the partial and
    // then cleared by a token advance goes through the normal line detector once a '\n' flushes it,
    // and trips again. Fail-closed and self-correcting — the next advancing frame clears it — but it
    // is a real flap, so it is pinned here rather than left incidental (roborev 46920).
    const { engine, last } = makeEngine();
    engine.ingest("✻ Working… (30s · ↓ 1.0k tokens · esc to interrupt)");
    engine.ingest("\rAPI Error: 500 Internal server error");
    expect(last()).toBe("errored");
    engine.ingest("\r✻ Working… (40s · ↓ 2.0k tokens · esc to interrupt)");
    expect(last()).toBe("working");
    engine.ingest("\n"); // flushes the buffered banner as a completed line
    expect(last()).toBe("errored");
    engine.ingest("✻ Working… (41s · ↓ 2.4k tokens · esc to interrupt)"); // and clears again
    expect(last()).toBe("working");
  });

  it("does NOT red on a user-ECHOED 'API Error:' line, terminated (pasting an error report)", () => {
    // roborev 47232/47233: the partial-banner check must scope to the unterminated tail, NOT scan
    // completed lines — those are the loop's job, and the loop skips a banner that is an echo of the
    // user's own just-submitted message (Fix 2). Pasting an "API Error: …" report to debug is the
    // common case; it must not paint the agent red.
    const { engine, last } = makeEngine();
    engine.noteUserInput("API Error: 500 Internal server error");
    engine.ingest("API Error: 500 Internal server error\n"); // echoed as a completed line
    expect(last()).toBe("working");
  });

  it("does NOT red on a user-echoed banner that arrives UNTERMINATED (input-box redraw)", () => {
    // roborev 47981/47996: the input box echoes the submission as an in-place redraw with NO trailing
    // '\n', so the echoed banner lands entirely in the unterminated tail — where the tail check runs.
    // The echo guard must apply HERE too, or this common shape reintroduces the exact false-red.
    const { engine, last } = makeEngine();
    engine.noteUserInput("API Error: 500 Internal server error");
    engine.ingest("API Error: 500 Internal server error"); // no newline — stays in the tail
    expect(last()).not.toBe("errored");
  });

  it("does NOT red on a user-echoed banner SPLIT across two chunks (both in the tail)", () => {
    // The echo can also arrive in fragments across chunk boundaries; the guard's substring match
    // covers the partial frame, and the completed half still lands in the tail unterminated.
    const { engine, last } = makeEngine();
    engine.noteUserInput("API Error: 500 Internal server error");
    engine.ingest("API Error: 500"); // first fragment (tail)
    engine.ingest(" Internal server error"); // rest still unterminated (tail)
    expect(last()).not.toBe("errored");
  });

  it("stays working on a banner line IMMEDIATELY followed by a classified tool event in one chunk", () => {
    // roborev 47232: "API Error: …\n<tool event>\n" — the banner trips in the loop, the tool event
    // clears it (genuine progress). The partial check must not RE-trip off that already-flushed
    // completed banner line; scoping to the tail (empty here) is what keeps the chunk green.
    const { engine, last } = makeEngine();
    engine.ingest("API Error: 500 Internal server error\nReading file src/foo.ts\n");
    expect(last()).toBe("working");
  });

  it("STILL reddens on a GENUINE unterminated banner (no echo window open)", () => {
    // The echo guard must not swallow a real mid-stream banner: with no noteUserInput, an unterminated
    // "API Error:" in the tail is a live failure and must trip (roborev 16152 preserved).
    const { engine, last } = makeEngine();
    engine.ingest("✻ Working… (30s · ↓ 1.0k tokens · esc to interrupt)");
    engine.ingest("\rAPI Error: 500 Internal server error"); // no newline, not an echo
    expect(last()).toBe("errored");
  });

  it("a REPEATED api banner stays token-clearable (a long turn can survive several blips)", () => {
    // Pins the deliberate choice not to escalate repeated banners to "churn": a healthy long turn can
    // hit several transient blips, and pinning it red is the false-red we set out to kill. A retry
    // loop with no generation is still caught by the frozen-counter rule (covered above).
    const { engine, last } = makeEngine();
    engine.ingest("✻ Incubating… (30s · ↓ 1.0k tokens · esc to interrupt)");
    engine.ingest("\nAPI Error: overloaded\n");
    engine.ingest("✻ Incubating… (40s · ↓ 2.0k tokens · esc to interrupt)");
    expect(last()).toBe("working");
    engine.ingest("\nAPI Error: overloaded\n"); // a second blip, same turn
    expect(last()).toBe("errored");
    engine.ingest("✻ Incubating… (50s · ↓ 3.0k tokens · esc to interrupt)");
    expect(last()).toBe("working");
  });

  it("a churn wedge is not a lockout — user input and real tool progress still clear it", () => {
    // The failureKind gate makes churn immune to TOKEN progress only. The original pqxh recovery
    // paths must still work, or a false-positive churn trip would pin an agent red for good.
    const viaUser = makeEngine();
    viaUser.engine.ingest("✻ Cogitating… (10s · ↑ 1.0k tokens · esc to interrupt)");
    viaUser.engine.ingest("\n…\n…\n…\n…\n…\n");
    expect(viaUser.last()).toBe("errored");
    viaUser.engine.noteUserInput("carry on");
    viaUser.engine.ingest("✻ Cogitating… (20s · ↑ 4.0k tokens · esc to interrupt)");
    expect(viaUser.last()).toBe("working");

    const viaTool = makeEngine();
    viaTool.engine.ingest("✻ Cogitating… (10s · ↑ 1.0k tokens · esc to interrupt)");
    viaTool.engine.ingest("\n…\n…\n…\n…\n…\n");
    expect(viaTool.last()).toBe("errored");
    viaTool.engine.ingest("Reading file src/foo.ts\n"); // a classified file event
    viaTool.engine.ingest("✻ Cogitating… (20s · ↑ 4.0k tokens · esc to interrupt)");
    expect(viaTool.last()).toBe("working");
  });

  it("still recovers on an advancing counter in a LATER turn (baseline reset is not a lockout)", () => {
    // The flip side of the reset: dropping the baseline must not disable the recovery for the rest of
    // the session — a genuinely advancing counter in turn 2 clears just like it does in turn 1.
    const { engine, last } = makeEngine(() => IDLE_SCREEN);
    engine.ingest("✻ Working… (5s · ↑ 40.0k tokens · esc to interrupt)"); // a long first turn
    vi.advanceTimersByTime(2000);
    expect(last()).toBe("idle");
    engine.ingest("✻ Working… (3s · ↓ 1.0k tokens · esc to interrupt)"); // turn 2 baseline
    engine.ingest("\nAPI Error: overloaded\n");
    expect(last()).toBe("errored");
    engine.ingest("✻ Working… (6s · ↓ 1.4k tokens · esc to interrupt)"); // generating again
    expect(last()).toBe("working");
  });

  it("catches a banner that sits in the unterminated partial (no trailing newline yet)", () => {
    // The banner streams in but its line hasn't been flushed by a '\n' — detection must still fire
    // off the partial buffer (roborev 16152).
    const { engine, last } = makeEngine();
    engine.ingest("API Error: Rate limited"); // no newline
    expect(last()).toBe("errored");
  });

  it("does NOT flag a SINGLE self-prompt ping in the unterminated partial (Bug A)", () => {
    // A self-prompt is a wedge only once it REPEATS, and repetition is counted off discrete
    // completed lines — so a lone self-ping still sitting in the partial (no trailing newline) must
    // NOT strand the tab red. (Formerly roborev 16176 tripped this on a single occurrence.)
    const { engine, last } = makeEngine();
    engine.ingest("Are you there?"); // no newline, single occurrence
    expect(last()).not.toBe("errored");
  });

  it("does NOT flag line-initial 'API Error' narration sitting in the partial (roborev 16177)", () => {
    // An in-progress heading that begins with "API Error" but isn't the colon-framed banner must
    // not strand the tab red while it's still streaming.
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest("\nAPI Error handling: returns 500 when"); // no newline, no banner colon
    expect(last()).toBe("working");
  });

  it("exits gray 'done' after a stream failure has RECOVERED (roborev 16177)", () => {
    // exit() reads errored only while still wedged; once a tool event cleared the flag, a clean
    // exit must settle to done, not errored.
    const { engine, last } = makeEngine();
    engine.ingest("API Error: Rate limited\n");
    expect(last()).toBe("errored");
    engine.ingest("Reading file src/foo.ts\n" + SPINNER); // real progress clears the failure
    expect(last()).toBe("working");
    engine.exit();
    expect(last()).toBe("done");
  });

  it("exits errored (not gray done) when the process dies still mid-stream-failed", () => {
    // A wedged agent (API error / self-prompt) that's then killed must read errored, not done —
    // even though no ERROR_PATTERNS line matched (roborev 16152).
    const { engine, last } = makeEngine();
    engine.ingest("API Error: Rate limited\n");
    expect(last()).toBe("errored");
    engine.exit();
    expect(last()).toBe("errored");
  });

  it("recovers to waiting when a real prompt follows a stream failure", () => {
    const { engine, last } = makeEngine();
    engine.ingest("API Error: overloaded\n");
    expect(last()).toBe("errored");
    // The agent recovered and is now genuinely asking the user (a real ❯ selection menu).
    engine.ingest("❯ 1. Yes\n");
    expect(last()).toBe("waiting");
  });

  it("does NOT flag agent narration that merely mentions API errors/overload (roborev 16153)", () => {
    // The banner matcher is anchored to the start of the visible line, so a healthy turn that simply
    // WRITES about these topics mid-sentence stays green — no false RED that would stick until the
    // next tool event.
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest("\nI'll add handling for the API Error case; the model can be overloaded.\n");
    expect(last()).toBe("working");
  });

  it("does NOT flag a benign short line repeated only a few times (roborev 16153)", () => {
    // A tool that echoes the same short progress line a handful of times (under the churn threshold)
    // must not paint red — especially since it then makes real progress.
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest("\n.\n.\n.\n"); // 3 repeats — under STALL_REPEAT_THRESHOLD (5)
    expect(last()).toBe("working");
    engine.ingest("Reading file src/foo.ts\n" + SPINNER);
    expect(last()).toBe("working");
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

// --- Bug A: a single user/agent utterance of a self-prompt phrase must NOT false-trip errored ---

describe("StatusEngine — self-prompt false-positive guard (Bug A)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const SPINNER = "✻ Cogitating… (12s · esc to interrupt)";

  it("does NOT go errored on a single 'Are you there? Give me an update.' line", () => {
    // The USER legitimately says this (and it's echoed back into pty:output). One occurrence is not
    // a wedge — the row stays working/idle, never red.
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest("Are you there? Give me an update.\n");
    expect(last()).not.toBe("errored");
    expect(last()).toBe("working");
  });

  it("does NOT go errored on a single 'Hey, Sparkler.' (the voice-UI wake phrase)", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest("Hey, Sparkler.\n");
    expect(last()).not.toBe("errored");
  });

  it("does NOT go errored when the agent merely QUOTES the phrase once in prose", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest('I\'ll add a wake phrase so users can say "hey Sparkler" to start dictation.\n');
    expect(last()).not.toBe("errored");
    expect(last()).toBe("working");
  });

  it("STILL goes errored on a genuine repeated self-ping loop (Bug A preserved)", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest("Are you there?\n");
    engine.ingest("Are you there?\n"); // repeats with no progress → wedge
    expect(last()).toBe("errored");
  });

  it("STILL goes errored on a single real 'API Error:' banner (only self-prompt got the gate)", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    // Leading newline flushes the spinner redraw so the banner lands on its own completed line.
    engine.ingest("\nAPI Error: 529 overloaded_error\n");
    expect(last()).toBe("errored");
  });
});

// --- Bug B: sticky errored must RECOVER when the user answers and the agent resumes working ---

describe("StatusEngine — user-input recovery (Bug B, noteUserInput)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const SPINNER = "✻ Cogitating… (12s · esc to interrupt)";

  it("recovers to working after the user answers, then a spinner tick (no tool event needed)", () => {
    const { engine, last } = makeEngine();
    // Put the engine into errored via a repeated self-ping loop.
    engine.ingest("Are you there?\n");
    engine.ingest("Are you there?\n");
    expect(last()).toBe("errored");
    // The user answers with a normal prose message — a NEW turn is starting.
    engine.noteUserInput("Let's build it. Go ahead...");
    // The agent resumes working: the live spinner comes back. It must go GREEN, not stay stuck red.
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
  });

  it("recovers via a thinking/prose line then a spinner — proving it needs no tool event", () => {
    const { engine, last } = makeEngine();
    engine.ingest("API Error: Rate limited\n"); // latch errored
    expect(last()).toBe("errored");
    engine.noteUserInput("let's build it. go ahead...");
    // A pure thinking/prose turn emits NO classified tool event — only prose then the spinner.
    engine.ingest("Twisting… almost done thinking\n");
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
  });

  it("suppresses the ECHO of the user's own message so it never re-trips errored (Fix 2)", () => {
    const { engine, last } = makeEngine();
    engine.noteUserInput("Are you there? Give me an update.");
    // The TUI echoes the submitted line back into pty:output — even twice — but it's the user's own
    // words, not a wedge. Must NOT go errored.
    engine.ingest("Are you there? Give me an update.\n");
    engine.ingest("Are you there? Give me an update.\n");
    expect(last()).not.toBe("errored");
  });

  it("does NOT let the user-input window permanently disable detection (wedge caught after it expires)", () => {
    const { engine, last } = makeEngine();
    engine.noteUserInput("go ahead and build it");
    // Burn through the echo window with unrelated benign output (no further user input, no tool event).
    for (let i = 0; i < 205; i++) engine.ingest(`log line number ${i}\n`);
    // Now a GENUINE self-ping loop starts with no user present — it must still go red.
    engine.ingest("Are you there?\n");
    engine.ingest("Are you there?\n");
    expect(last()).toBe("errored");
  });

  it("a TINY user message does not broadly suppress detection (substring gate, roborev)", () => {
    // "go" is under the substring-match floor, so echo suppression falls back to exact equality —
    // it must NOT skip a genuine self-ping loop just because those lines happen to contain "go".
    const { engine, last } = makeEngine();
    engine.noteUserInput("go");
    engine.ingest("Are you there? going in circles?\n");
    engine.ingest("Are you there? going in circles?\n"); // repeated self-ping → real wedge
    expect(last()).toBe("errored");
  });

  it("clears a latched error even without immediately following output (flags lifted, spinner wins)", () => {
    const { engine, last } = makeEngine();
    engine.ingest("API Error: overloaded\n");
    expect(last()).toBe("errored");
    engine.noteUserInput("retry please");
    // Next tick is just the resuming spinner — with the sticky flag lifted, it classifies working.
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
  });
});

// --- Transition logging: the record that makes a status bug diagnosable at all ---
//
// Motivating incident: a user reported an agent flapping working↔blocked, and "why did it flip?"
// had no answer — a full day of app logs contained ZERO lines about status. The engine published
// only the RESULT of its reasoning. These rows pin the three properties that make the new line
// worth having: it fires on real transitions with the right TRIGGER, it stays SILENT when nothing
// changed (this runs per PTY chunk for every agent), and it never carries terminal content.

describe("StatusEngine — transition logging", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const SPINNER = "✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)";

  /** An engine with a known agent id, so the assertions read like the grep a human would run. */
  function logged(agentId: string, getScreen?: () => string) {
    return new StatusEngine({ agentId, onStatus: () => {}, getScreen });
  }

  it("records the starting status, so a history never begins mid-story", () => {
    logged("a1");
    expect(transitionLines()).toEqual([expect.stringMatching(/^agent-status agent=a1 \(new\)->working trigger=spawn mono=\d+$/)]);
  });

  it("logs settle-to-idle with the spinner-gone trigger and the CALM screen verdict", () => {
    const engine = logged("a2", () => IDLE_SCREEN);
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(2000); // spinner stops re-drawing → settle
    expect(transitionLines().at(-1)).toMatch(
      /^agent-status agent=a2 working->idle trigger=spinner-gone-settle screen=calm mono=\d+$/,
    );
  });

  it("distinguishes the LEGACY quiet settle from the spinner one — same status, different story", () => {
    // No spinner is ever observed here, so this settles off the IDLE_MS stall timer. Reading
    // `trigger=quiet-settle` in the log is how you tell "the turn ended" from "we never saw a
    // spinner and guessed from silence" — the two produce an identical gray dot.
    const engine = logged("a3", () => IDLE_SCREEN);
    engine.ingest("doing work\n");
    vi.advanceTimersByTime(2500);
    expect(transitionLines().at(-1)).toMatch(
      /^agent-status agent=a3 working->idle trigger=quiet-settle screen=calm mono=\d+$/,
    );
  });

  it("says BLANK, not calm, when settle had no getScreen to read at all", () => {
    // roborev 54741. `logged("b1")` wires no `getScreen` — the shape of every construction that
    // omits it (the mid-stream rows below, redAttentionTaxonomy.test.ts, and any caller that has no
    // terminal attached). `screenAwaitsInput` short-circuits false on an empty snapshot BEFORE it
    // examines anything, so logging `calm` here claimed a classification that never happened: it was
    // indistinguishable from "the classifier read a real screen and found no question". A blank
    // snapshot is a leading suspect for the false-GRAY bug this line exists to diagnose, so the
    // undifferentiated verdict hid the log's own subject.
    const engine = logged("b1");
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(2000); // spinner stops re-drawing → settle
    expect(transitionLines().at(-1)).toMatch(
      /^agent-status agent=b1 working->idle trigger=spinner-gone-settle screen=blank mono=\d+$/,
    );
  });

  it("says BLANK when the snapshot is an empty viewport of whitespace", () => {
    // The other half of the same finding: `snapshotScreen` returns a run of blank lines whenever the
    // visible viewport is empty, which reaches the classifier as a non-undefined string that still
    // short-circuits. The resulting STATUS is idle either way — only this line can tell a real calm
    // screen from no screen at all, which is the whole reason it was added.
    const engine = logged("b2", () => "\n \n\n   \n");
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(2000);
    expect(transitionLines().at(-1)).toMatch(
      /^agent-status agent=b2 working->idle trigger=spinner-gone-settle screen=blank mono=\d+$/,
    );
  });

  it("logs a mid-stream prompt with its own trigger, and no screen verdict (none was read)", () => {
    const engine = logged("a4");
    engine.ingest("Do you want to proceed? (y/n)\n");
    const line = transitionLines().at(-1) ?? "";
    expect(line).toMatch(/^agent-status agent=a4 working->waiting trigger=prompt-detected-midstream mono=\d+$/);
    // The verdict field is omitted rather than guessed: this path classified the STREAM, not a
    // rendered snapshot, so claiming a screen verdict here would be a fabricated datum.
    expect(line).not.toContain("screen=");
  });

  it("logs the process exit", () => {
    const engine = logged("a5");
    engine.ingest("All tasks complete.\n");
    engine.exit();
    expect(transitionLines().at(-1)).toMatch(/^agent-status agent=a5 working->done trigger=process-exit mono=\d+$/);
  });

  it("logs an exit that is errored, not the status it would have had", () => {
    const engine = logged("a6");
    engine.ingest("Error: cannot find module 'foo'\n");
    engine.exit();
    expect(transitionLines().at(-1)).toMatch(/^agent-status agent=a6 working->errored trigger=process-exit mono=\d+$/);
  });

  it("emits NOTHING when chunks arrive and the status does not change", () => {
    // The hot path. This runs per PTY chunk for every live agent, and the overwhelmingly common
    // case is "no change" — a line here would be both noise and cost.
    const engine = logged("a7");
    logInfo.mockClear(); // drop the spawn line; we're asserting on the chunks alone
    engine.ingest("compiling module A\n"); // fallback: working → working
    engine.ingest(SPINNER); // spinner: working → working
    engine.ingest(SPINNER);
    engine.ingest("still compiling\n");
    expect(transitionLines()).toEqual([]);
  });

  it("logs the screen VERDICT and never the screen text", () => {
    // Terminal content is user data and can be large. `screen=awaiting` is the whole finding; the
    // text that convinced the classifier must not reach the log file.
    const engine = logged("a8", () => PERMISSION_SCREEN);
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(2000);
    const line = transitionLines().at(-1) ?? "";
    expect(line).toMatch(/^agent-status agent=a8 working->waiting trigger=spinner-gone-settle screen=awaiting mono=\d+$/);
    expect(line).not.toContain("Do you want to make this edit");
    expect(line).not.toContain("❯");
  });

  it("gives ONE grep an agent's full history, uncontaminated by the other agents", () => {
    // The acceptance test for the whole feature: `grep "agent-status agent=<id>"` on sparkle.log.
    const a = logged("alpha", () => IDLE_SCREEN);
    const b = logged("beta", () => PERMISSION_SCREEN);
    a.ingest(SPINNER);
    b.ingest(SPINNER);
    vi.advanceTimersByTime(2000); // both settle — alpha to gray, beta to red
    a.ingest("Do you want to proceed? (y/n)\n");
    a.exit();

    const grep = (id: string) => transitionLines().filter((l) => l.startsWith(`${STATUS_TRANSITION_MARKER} agent=${id} `));
    expect(grep("alpha").map((l) => l.replace(/ mono=\d+$/, ""))).toEqual([
      "agent-status agent=alpha (new)->working trigger=spawn",
      "agent-status agent=alpha working->idle trigger=spinner-gone-settle screen=calm",
      "agent-status agent=alpha idle->waiting trigger=prompt-detected-midstream",
      "agent-status agent=alpha waiting->done trigger=process-exit",
    ]);
    expect(grep("beta").map((l) => l.replace(/ mono=\d+$/, ""))).toEqual([
      "agent-status agent=beta (new)->working trigger=spawn",
      "agent-status agent=beta working->waiting trigger=spinner-gone-settle screen=awaiting",
    ]);
  });

  it("stamps a non-decreasing monotonic clock, so gaps between flips are measurable", () => {
    // Wall-clock stamps can't answer "how long between the flips?" across an NTP correction or a
    // sleep/wake — which is exactly when a stall-timer bug shows up.
    const engine = logged("a9", () => IDLE_SCREEN);
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(2000);
    engine.exit();
    const stamps = transitionLines().map((l) => Number(/mono=(\d+)$/.exec(l)?.[1]));
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    expect(stamps.every((n) => Number.isFinite(n))).toBe(true);
    expect([...stamps].sort((x, y) => x - y)).toEqual(stamps);
  });
});

describe("a disposed engine goes silent", () => {
  // roborev 55076. The PTY listener is torn down over an ASYNC Tauri unlisten, so a `pty:exit` from
  // this engine's own kill can arrive after the pane remounted. If `exit()` still ran, its `set()`
  // would overwrite the LIVE agent's status with a terminal `done`/`errored` — which opens the
  // destructive-op gate through LIVE_AGENT_STATUSES entirely on its own, independently of the
  // turn-end-witness path.
  //
  // Fake timers here for the same reason the main suite uses them: the resurrection this guards
  // against is a re-armed setTimeout, so the test has to be able to advance past it.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ignores a late pty:data chunk — no status write, no resurrected timers", () => {
    // roborev 55094. `pty:data` is unlistened over the same async round-trip as `pty:exit`, so a
    // dead PTY's chunk can reach the old engine after the pane remounted. Without the latch it would
    // write a status onto the LIVE agent's row and re-arm the timers dispose() just cleared, so the
    // corpse keeps writing for another SCREEN_RECHECK_MS.
    const { engine, statuses } = makeEngine(() => IDLE_SCREEN);
    engine.ingest("doing work\n");
    engine.dispose();
    const before = statuses.length;
    engine.ingest("✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)");
    engine.ingest("more output\n");
    vi.advanceTimersByTime(60_000); // nothing may fire from a resurrected timer
    expect(statuses.length).toBe(before);
  });

  it("ignores a pty:exit that arrives after dispose", () => {
    const { engine, statuses } = makeEngine();
    engine.ingest("doing work\n");
    const before = statuses.length;
    engine.dispose();
    engine.exit();
    expect(statuses.length).toBe(before);
    expect(statuses).not.toContain("done");
    expect(statuses).not.toContain("errored");
  });
});

// ── THE FAILURE BANNER, RETAINED VERBATIM ───────────────────────────────────────────────────────
// `pusherFleet.sharedFailureCohorts` groups agents by this exact string to recognise that ONE host
// event killed several of them at once. That only works if nothing here normalises it, and only
// stays honest if it clears when the agent demonstrably recovers.
describe("lastFailureNow", () => {
  const SPINNER = "✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)";
  const OFFLINE = "API Error: Unable to connect to API (ENOTFOUND)";

  it("is undefined on a healthy agent — an absent observation never manufactures a failure", () => {
    const { engine } = makeEngine();
    engine.ingest(SPINNER);
    expect(engine.lastFailureNow()).toBeUndefined();
  });

  // EXACT equality, not `toContain` (roborev 57313). `toContain` passes for the marker-prefixed and
  // spinner-fused forms too, so it was structurally incapable of catching the two capture points
  // disagreeing — which is the only property `sharedFailureCohorts` depends on.
  it("retains the banner VERBATIM from a completed line", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest(`\n⏺ ${OFFLINE}\n`);
    expect(last()).toBe("errored");
    expect(engine.lastFailureNow()?.message).toBe(OFFLINE);
  });

  // The live shape — no trailing newline — which is how the founder's five agents actually died.
  it("retains the banner from the unterminated tail too", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest(`\r⏺ ${OFFLINE}`);
    expect(last()).toBe("errored");
    expect(engine.lastFailureNow()?.message).toBe(OFFLINE);
  });

  // THE PROPERTY THE COHORT GROUPING ACTUALLY NEEDS: identical bytes from both paths. Two agents
  // killed by one host event differ only in whether their banner happened to flush with a newline,
  // and an exact-equality Map key turns that accident into two separate cohorts — so the outage is
  // never reported. It fails OPEN, which looks exactly like "no outage".
  it("produces IDENTICAL bytes whichever path captured it", () => {
    const flushed = makeEngine();
    flushed.engine.ingest(SPINNER);
    flushed.engine.ingest(`\n⏺ ${OFFLINE}\n`);

    const live = makeEngine();
    live.engine.ingest(SPINNER);
    live.engine.ingest(`\r⏺ ${OFFLINE}`);

    expect(flushed.engine.lastFailureNow()!.message).toBe(live.engine.lastFailureNow()!.message);
  });

  // The documented fused shape: the spinner redraws with \r and the banner lands on the same line.
  // Storing the raw line here would carry the elapsed seconds and token count — unique per agent, so
  // it could never group, and the report would whitelist those numbers as if they were measured.
  // Two banners redrawn onto ONE line: the LAST is the current state of the turn, matching how
  // `wallInTail` takes the last wall. Without this the first-vs-last choice is untestable, because
  // `apiErrorFramesIn` filters to banner frames and a single-banner line makes them identical.
  it("stores the LAST banner when one line carries two", () => {
    const { engine } = makeEngine();
    engine.ingest(`\n⏺ API Error: 529 Overloaded.\r⏺ ${OFFLINE}\n`);
    expect(engine.lastFailureNow()?.message).toBe(OFFLINE);
  });

  it("stores the banner ALONE when it is fused onto a spinner frame", () => {
    const { engine } = makeEngine();
    engine.ingest(`${SPINNER}\r⏺ ${OFFLINE}\n`);
    expect(engine.lastFailureNow()?.message).toBe(OFFLINE);
  });

  it("stamps when it arrived, so a cohort can be bounded against the clock", () => {
    const { engine } = makeEngine();
    const before = Date.now();
    engine.ingest(SPINNER);
    engine.ingest(`\r⏺ ${OFFLINE}`);
    const at = engine.lastFailureNow()!.at;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  // THE ASYMMETRY WITH `quotaBlock`, and the reason the Pusher can trust this field. A quota wall is
  // a claim about the ACCOUNT that outlives the red; this is a claim about a turn that died, so the
  // moment the agent classifies real work it is demonstrably not sitting in that failure any more.
  // Without this it would be a permanent stamp of the last bad turn.
  it("clears when the agent demonstrably recovers", () => {
    const { engine, last } = makeEngine();
    engine.ingest(`${OFFLINE}\n`);
    expect(engine.lastFailureNow()?.message).toContain(OFFLINE);
    expect(last()).toBe("errored");

    // The same recovery the red itself honours: a classified file event plus a spinner.
    engine.ingest("Reading file src/foo.ts\n" + SPINNER);
    expect(last()).toBe("working");
    expect(engine.lastFailureNow()).toBeUndefined();
  });

  // The same guard the red itself uses: a human pasting the banner into the composer, or an agent
  // reading a log, must not make it look like a shared casualty.
  it("does not retain a banner that is only a TOOL RESULT", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest(`\n  ⎿  ${OFFLINE}\n`);
    expect(last()).toBe("working");
    expect(engine.lastFailureNow()).toBeUndefined();
  });
});

// ── The session-limit picker, end to end (PRD/sparkle/claude-account-identity-truth.md §6) ──────
//
// The founder's fleet was parked on Claude Code's session-limit dialog while every row read GREEN.
// The engine and the router each hold half of the fix, and neither half is worth anything alone —
// so these drive the REAL pair, the way Terminal + AgentPane wire them, and assert the colour a
// human would have seen.

describe("StatusEngine — the session-limit picker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const SPINNER = "✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)";

  /** Engine → router, exactly the chain Terminal's `onStatusWithCapture` and AgentPane's
   *  `(s) => router.fromScreen(s)` form in production. */
  function wired(getScreen: () => string) {
    const emitted: AgentTabStatus[] = [];
    const transitions: StatusTransition[] = [];
    const router = createStatusRouter(
      (s) => emitted.push(s),
      undefined,
      (t) => transitions.push(t),
    );
    const engine = new StatusEngine({ agentId: "wired", onStatus: (s) => router.fromScreen(s), getScreen });
    return { engine, router, emitted, transitions };
  }

  it("turns the row RED behind a hook frozen at `working` — the founder's screen", () => {
    const screen = { v: "⏺ Working on it." };
    const { engine, router, emitted, transitions } = wired(() => screen.v);
    router.activate();
    router.fromHook("working"); // the turn opens…
    engine.ingest(SPINNER);
    // …and the session limit lands INSIDE it, so Claude draws the picker and no `Stop` ever fires.
    screen.v = SESSION_LIMIT_PICKER;
    vi.advanceTimersByTime(2000); // the spinner stops re-drawing → settle reads the viewport
    expect(emitted).toEqual(["working", "waiting"]);
    expect(transitions.at(-1)?.reason).toBe("session-limit-picker");
    expect(transitions.at(-1)?.lastHook).toBe("working"); // the hook is still frozen; we overrode it
  });

  it("holds RED after the picker leaves the screen, until the agent actually resumes", () => {
    const screen = { v: "⏺ Working on it." };
    const { engine, router, emitted } = wired(() => screen.v);
    router.activate();
    router.fromHook("working");
    engine.ingest(SPINNER);
    screen.v = SESSION_LIMIT_PICKER;
    vi.advanceTimersByTime(2000);
    expect(emitted.at(-1)).toBe("waiting");
    // A recovery service presses Esc. The dialog goes away and the screen is calm — but nothing yet
    // says the agent is unstuck, and the hook is STILL frozen at `working`. Retracting here would
    // repaint the row green on a possibly-still-walled agent: the exact bug, relocated.
    screen.v = IDLE_SCREEN;
    engine.ingest("\n");
    vi.advanceTimersByTime(30_000);
    expect(emitted.at(-1)).toBe("waiting");
    // Real output resumes → green, on evidence.
    engine.ingest(SPINNER);
    expect(emitted.at(-1)).toBe("working");
  });

  it("does NOT route into the quota band — `failureKind` and the wall are untouched", () => {
    // Load-bearing (PRD §6c): `noteUserInput` computes keepQuota = machine && failureKind==="quota"
    // and only a HUMAN reaches releaseQuotaBlock. A picker routed into that band would leave a
    // machine resume unable to clear it, or force it to bypass the guard that exists to kill the
    // self-concealing resume loop.
    const { engine, statuses } = makeEngine(() => SESSION_LIMIT_PICKER);
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(2000);
    expect(statuses.at(-1)).toBe("waiting");
    expect(statuses).not.toContain("blocked");
    expect(statuses).not.toContain("errored");
    expect(engine.quotaBlockNow(Date.now())).toBeUndefined();
  });

  it("stays `waiting` rather than `approval`, even if a risky action was seen this turn", () => {
    // Nothing dangerous is being approved here, and the recovery path keys off the reason code, not
    // the band — so the band must not drift to the one reserved for "approve this destructive thing".
    const RISKY = "Bash(rm -rf build/)\n"; // classifies as approval_needed → arms the risk flag
    // CONTROL FIRST, or this test proves nothing: the same input against an ordinary permission
    // screen really does reach `approval`, so the `waiting` below is the picker's doing.
    const control = makeEngine(() => PERMISSION_SCREEN);
    control.engine.ingest(RISKY);
    control.engine.ingest(SPINNER);
    vi.advanceTimersByTime(2000);
    expect(control.statuses.at(-1)).toBe("approval");

    const { engine, statuses } = makeEngine(() => SESSION_LIMIT_PICKER);
    engine.ingest(RISKY);
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(2000);
    expect(statuses.at(-1)).toBe("waiting");
  });

  it("attaches the reason when the picker streams past mid-turn (no settle ever runs)", () => {
    // The common real path, and the one that silently broke the first design: the picker's footer
    // arrives as OUTPUT, so `prompt-detected-midstream` paints `waiting` and returns WITHOUT arming
    // a settle. A walled agent then prints nothing more, so if the viewport were never re-read the
    // reason would never exist and the row would stay green behind the frozen hook.
    const { engine, router, emitted, transitions } = wired(() => SESSION_LIMIT_PICKER);
    router.activate();
    router.fromHook("working");
    engine.ingest(" Enter to confirm · Esc to cancel\n");
    expect(emitted).toEqual(["working", "waiting"]);
    expect(transitions.at(-1)?.reason).toBe("session-limit-picker");
  });

  it("re-reads the viewport when the dialog paints AFTER its footer streamed past", () => {
    // xterm paints on its own schedule, so the grid can still be showing the previous frame at the
    // instant the footer arrives. One late read is what closes that race.
    const screen = { v: "⏺ Working on it." };
    const { engine, router, emitted, transitions } = wired(() => screen.v);
    router.activate();
    router.fromHook("working");
    engine.ingest(" Enter to confirm · Esc to cancel\n"); // prompt seen in the STREAM…
    expect(emitted).toEqual(["working"]); // …viewport not painted yet, so no pierce and no reason
    expect(transitions.at(-1)?.reason).toBeNull();
    screen.v = SESSION_LIMIT_PICKER; // now xterm draws it
    vi.advanceTimersByTime(2000);
    expect(emitted).toEqual(["working", "waiting"]);
    expect(transitions.at(-1)?.reason).toBe("session-limit-picker");
  });

  it("announces to a listener that never imports the screen classifier — once per episode", () => {
    // W-RESUME's trigger. It must not have to reach into `screenClassifier` to learn which agent is
    // parked on the dialog, and it must not act on the bare `waiting` band (which also means a
    // permission dialog, an AskUserQuestion menu, a /model picker — sending Esc at any of those
    // cancels an answer the human was mid-way through giving).
    const seen: SessionLimitPickerDetail[] = [];
    const off = onSessionLimitPicker((d) => seen.push(d));
    try {
      const screen = { v: SESSION_LIMIT_PICKER };
      const { engine } = makeEngine(() => screen.v);
      engine.ingest(SPINNER);
      vi.advanceTimersByTime(2000);
      expect(seen.map((d) => d.agentId)).toEqual(["test"]);
      // A second settle on the SAME unanswered dialog is not new news.
      engine.ingest(SPINNER);
      vi.advanceTimersByTime(2000);
      expect(seen).toHaveLength(1);
      // …but a picker that comes BACK after a resume attempt is: that is how "the resume did not
      // take" becomes observable instead of assumed.
      screen.v = IDLE_SCREEN;
      engine.ingest(SPINNER);
      vi.advanceTimersByTime(2000);
      screen.v = SESSION_LIMIT_PICKER;
      engine.ingest(SPINNER);
      vi.advanceTimersByTime(2000);
      expect(seen).toHaveLength(2);
    } finally {
      off();
    }
  });

  it("also dispatches the sparkle://session-limit-picker window event when a DOM is present", () => {
    // The contract's named channel. These suites run under vitest's default `node` environment, so
    // the DOM half is stubbed rather than assumed — the guard in announceSessionLimitPicker is what
    // keeps it from throwing on the hot path in a non-DOM context.
    const dispatched: Array<{ type: string; detail: unknown }> = [];
    class FakeCustomEvent {
      constructor(
        readonly type: string,
        readonly init?: { detail?: unknown },
      ) {}
      get detail() {
        return this.init?.detail;
      }
    }
    vi.stubGlobal("CustomEvent", FakeCustomEvent);
    vi.stubGlobal("window", {
      dispatchEvent: (e: FakeCustomEvent) => dispatched.push({ type: e.type, detail: e.detail }),
    });
    try {
      const { engine } = makeEngine(() => SESSION_LIMIT_PICKER);
      engine.ingest(SPINNER);
      vi.advanceTimersByTime(2000);
      expect(dispatched).toEqual([
        { type: SESSION_LIMIT_PICKER_EVENT, detail: { agentId: "test", at: expect.any(Number) } },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("announces nothing for any OTHER picker, and does not call it a session limit", () => {
    // WHAT THIS TEST USED TO PIN, and why it changed. It asserted `emitted === ["working"]` — an
    // ordinary permission dialog behind a frozen hook left the row GREEN — citing sparkle-7wij, the
    // known mid-turn gap. That green is precisely the bug the founder then reported: several agents
    // sat on an unanswered `rename_agent` approval while every row read green, and he found it only
    // by opening panes one at a time. The session-limit pierce was carved narrowly because the
    // router had no other signal to trust; it now has one (a VIEWPORT-CONFIRMED prompt reason), so
    // the carve-out is no longer the whole answer and this row goes red like any other blocked agent.
    //
    // Everything this test was GENUINELY guarding is unchanged and still asserted below: an ordinary
    // permission dialog must not be mistaken for a session limit — no `session-limit-picker` reason,
    // and no announcement on the picker channel (which arms a machine keystroke).
    const seen: SessionLimitPickerDetail[] = [];
    const off = onSessionLimitPicker((d) => seen.push(d));
    try {
      const { engine, router, emitted, transitions } = wired(() => PERMISSION_SCREEN);
      router.activate();
      router.fromHook("working"); // same frozen hook…
      engine.ingest(SPINNER);
      vi.advanceTimersByTime(2000);
      // …and the row is now RED, because the human really is on the hook.
      expect(isRedStatus(emitted.at(-1)!)).toBe(true);
      // The still-load-bearing half: classified as an approval, never as a session limit.
      expect(transitions.at(-1)?.reason).toBe("tool-approval-prompt");
      expect(transitions.every((t) => t.reason !== "session-limit-picker")).toBe(true);
      expect(seen).toEqual([]);
    } finally {
      off();
    }
  });
});

// BUG 1, the founder's second sighting of the invisible-green state: several agents sat on an MCP
// tool-approval dialog (`rename_agent`) while their rows read GREEN, and he found it only by opening
// panes one at a time. Same mechanism as the session-limit suite above — the dialog opens MID-TURN,
// so no `Stop` fires, the hook freezes at `working`, and the router's idle-only escalation never
// gets a look. Driven through the REAL engine+router pair, because neither half fixes it alone.
describe("StatusEngine — a tool-approval prompt never reads green", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const SPINNER = "✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)";

  function wired(getScreen: () => string) {
    const emitted: AgentTabStatus[] = [];
    const transitions: StatusTransition[] = [];
    const router = createStatusRouter(
      (s) => emitted.push(s),
      undefined,
      (t) => transitions.push(t),
    );
    const engine = new StatusEngine({ agentId: "wired-approval", onStatus: (s) => router.fromScreen(s), getScreen });
    return { engine, router, emitted, transitions };
  }

  it("THE TEST: turns the row RED behind a hook frozen at `working` — an unanswered Approve? dialog", () => {
    const screen = { v: "⏺ Working on it." };
    const { engine, router, emitted, transitions } = wired(() => screen.v);
    router.activate();
    router.fromHook("working"); // the turn opens…
    engine.ingest(SPINNER);
    // …and the approval dialog lands INSIDE it. Claude draws the permission box and waits; because
    // the turn never ends, no Stop event ever follows and `lastHook` is frozen at "working" forever.
    screen.v = APPROVAL_2_1_220;
    vi.advanceTimersByTime(2000); // spinner stops re-drawing → settle reads the viewport
    // Against the code as it stood this read ["working"]: green, on an agent stopped waiting for a
    // human. `isRedStatus` is the predicate the human is actually paged on.
    expect(emitted.at(-1)).not.toBe("working");
    expect(isRedStatus(emitted.at(-1)!)).toBe(true);
    expect(transitions.at(-1)?.reason).toBe("tool-approval-prompt");
    expect(transitions.at(-1)?.lastHook).toBe("working"); // frozen hook overridden, not repaired
  });

  it("retracts the moment the human answers and the agent resumes", () => {
    // The property the session-limit latch deliberately gives up and this one keeps: no stale
    // "Needs you" row. Answering an approval dialog is the only thing that dismisses it, so the
    // resumed spinner is trustworthy evidence in a way an Esc'd session-limit picker is not.
    const screen = { v: "⏺ Working on it." };
    const { engine, router, emitted } = wired(() => screen.v);
    router.activate();
    router.fromHook("working");
    engine.ingest(SPINNER);
    screen.v = APPROVAL_2_1_220;
    vi.advanceTimersByTime(2000);
    expect(isRedStatus(emitted.at(-1)!)).toBe(true);
    // The human presses 1. The dialog goes away and output resumes.
    screen.v = IDLE_SCREEN;
    engine.ingest(SPINNER);
    expect(emitted.at(-1)).toBe("working");
  });

  it("a redrawn dialog does not silently retract the pierce (mid-stream must not lower the reason)", () => {
    // The subtle one. The late re-check confirms the dialog on the rendered grid and raises
    // `tool-approval-prompt`. Then the dialog REDRAWS, so `ingest` detects a prompt in the stream
    // again and re-emits. Because the reason is part of `set`'s dedup key, emitting a bare `waiting`
    // there counts as a change, reaches the router, and drops the pierce — handing the row back to
    // the frozen `working` hook. Green again, on an agent still parked on the dialog.
    const screen = { v: "⏺ Working on it." };
    const { engine, router, emitted } = wired(() => screen.v);
    router.activate();
    router.fromHook("working");
    engine.ingest(SPINNER);
    screen.v = APPROVAL_2_1_220;
    vi.advanceTimersByTime(2000);
    expect(isRedStatus(emitted.at(-1)!)).toBe(true);
    expect(emitted).toEqual(["working", "waiting"]);
    // The dialog is still on screen and streams another frame of itself.
    engine.ingest(APPROVAL_2_1_220);
    vi.advanceTimersByTime(2000);
    // ASSERT THE WHOLE SEQUENCE, not just the final state. The bug is a TRANSIENT green: without the
    // reason carried forward the row goes working -> waiting -> WORKING -> waiting, flashing green for
    // the ~2s until the late re-check re-raises the reason. Reading only `emitted.at(-1)` sees the
    // recovered red and passes vacuously — which is how this very test first shipped green against the
    // broken code. A row that blinks green while its agent is parked on a dialog is the whole defect.
    expect(emitted).toEqual(["working", "waiting"]);
  });

  it("the carried reason RETRACTS on a calm viewport, even while the stream still trips `prompt`", () => {
    // The retraction half of the carry-forward, and the one that keeps it from becoming a latch.
    // `prompt` is sticky across chunks — screenAwaitsInput scans the whole unterminated partial — so
    // after the human answers, spinner frames appended to a partial still holding the pre-answer
    // "❯ 1." line keep re-tripping the mid-stream path. If the carry keyed off `statusReason` alone
    // it would re-raise the reason forever and clearTimers() would kill the settle that corrects it,
    // pinning the row on "Needs you" while the agent is demonstrably generating. Gating the carry on
    // the VIEWPORT is what lets it self-correct.
    const screen = { v: "⏺ Working on it." };
    const { engine, router, emitted } = wired(() => screen.v);
    router.activate();
    router.fromHook("working");
    engine.ingest(SPINNER);
    screen.v = APPROVAL_2_1_220;
    vi.advanceTimersByTime(2000);
    expect(emitted).toEqual(["working", "waiting"]);
    // The human answers. The GRID is calm now, but the stream still carries the old menu text.
    screen.v = IDLE_SCREEN;
    engine.ingest(APPROVAL_2_1_220);
    expect(emitted).toEqual(["working", "waiting", "working"]);
  });

  it("a redraw does not demote a risky `approval` to a plain `waiting`", () => {
    // `sawRecentRisk` is consumed by the mid-stream path, so the SECOND detection of the same dialog
    // reads false and would silently relabel a destructive-action prompt as an ordinary question for
    // the life of the dialog. The row stays red either way, so this is narrower than the green flash
    // — but it is the same class of lie, and it never recovers on its own.
    const RISKY = "Bash(rm -rf build/)\n"; // classifies as approval_needed → arms the risk flag
    const screen = { v: "⏺ Working on it." };
    const { engine, router, emitted } = wired(() => screen.v);
    router.activate();
    router.fromHook("working");
    engine.ingest(SPINNER);
    engine.ingest(RISKY);
    screen.v = APPROVAL_2_1_220;
    vi.advanceTimersByTime(2000);
    expect(emitted.at(-1)).toBe("approval");
    // The dialog redraws while still on the grid — the band must survive it.
    engine.ingest(APPROVAL_2_1_220);
    vi.advanceTimersByTime(2000);
    expect(emitted.filter((s) => s === "waiting")).toEqual([]);
    expect(emitted.at(-1)).toBe("approval");
  });

  it("a redraw BEFORE the reason is raised does not demote the risky band either", () => {
    // The ordinary ordering, and the half the first band test missed. The reason is only raised by
    // the late re-check ~2s after the dialog appears, so a redraw inside that window sees
    // sawRecentRisk already consumed AND no reason yet. Gating the band on the carried reason left
    // this path demoting approval -> waiting exactly as before — permanently, because the re-check
    // then re-emits the CURRENT band and never re-consults risk. The band is gated on the viewport
    // instead, which is true from the very first detection.
    const RISKY = "Bash(rm -rf build/)\n"; // classifies as approval_needed → arms the risk flag
    const screen = { v: "⏺ Working on it." };
    const { engine, router, emitted } = wired(() => screen.v);
    router.activate();
    router.fromHook("working");
    engine.ingest(SPINNER);
    engine.ingest(RISKY);
    screen.v = APPROVAL_2_1_220;
    engine.ingest(APPROVAL_2_1_220); // first mid-stream detection → engine `approval`, reason null
    // The ROUTER does not pierce yet, and must not: this detection came from the stream, so it
    // carries no reason and the frozen `working` hook still wins. That is the boundary working.
    expect(emitted.at(-1)).toBe("working");
    // A repaint of the same dialog, still inside the pre-re-check window. It does NOT re-emit the
    // risky line — a cursor/footer repaint alone is enough to re-trip `prompt`. This is where the
    // band was being demoted.
    engine.ingest(APPROVAL_2_1_220);
    // Now the late re-check fires, confirms the viewport and raises the reason — re-emitting the
    // CURRENT band. If the redraw above demoted it, the row locks on `waiting` forever.
    vi.advanceTimersByTime(2000);
    expect(emitted.at(-1)).toBe("approval");
    expect(emitted.filter((s) => s === "waiting")).toEqual([]);
  });

  it("a calm screen behind a frozen hook still reads green — no new false red", () => {
    // The other half of the trade. The pierce must fire ONLY on a viewport that really shows a
    // prompt; a long tool call (hooks legitimately silent, nothing on screen) must stay green, or
    // this fix would page the founder on every healthy agent.
    const screen = { v: IDLE_SCREEN };
    const { engine, router, emitted } = wired(() => screen.v);
    router.activate();
    router.fromHook("working");
    engine.ingest(SPINNER);
    vi.advanceTimersByTime(60_000);
    expect(emitted.at(-1)).toBe("working");
  });
});
