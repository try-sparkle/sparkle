// The founder's 2026-07-15 bug, end to end, at the highest level reachable without a GUI.
//
// Every other test on this branch exercises one piece. This one wires the REAL hook path together —
// watchHookEvents → createHookEventHandler → HookStatusEngine → createStatusRouter — and drives it
// with a hook log that STOPS BEING WRITTEN mid-session, which is what a clobbered emitter in
// .claude/settings.local.json actually looks like from the app's side.
//
// Why this exists: a green unit suite could not see this bug. The pieces were individually correct;
// the wedge lived in how they compose over time.
//
// WHAT IS REAL: everything from the log line inward — parsing, the session lock, the turn-closed
// logic, status derivation, and the router's arbitration.
//
// WHAT IS SIMULATED — be precise, because this file is positioned as the thing units can't do:
//   - `poll` — watchHookEvents' own existing test hook, standing in for the Tauri
//     `read_events_since` command.
//   - the clock — injected, so no fake timers.
//   - the SCREEN SCRAPER — `router.fromScreen(...)` is called directly. statusEngine.ts never runs
//     here, so this asserts "the row goes green GIVEN the scraper reports working"; it does NOT
//     verify the scraper would in fact report working during an outage. That link is load-bearing
//     in the founder's repro and is covered only by statusEngine's own tests + a live pass.
//   - the FOLLOWUP JUDGE — `router.fromJudge(...)`, likewise; and `captureHistory` is a spy, so
//     nothing here proves the real judge dispatches off a Stop.
import { describe, it, expect, vi } from "vitest";
import { watchHookEvents } from "../services/hookWatcher";
import { HookStatusEngine, createHookEventHandler, type HookEvent } from "./hookEvents";
import { createStatusRouter, HOOK_STALE_MS, type StatusRouter } from "./statusRouter";
import type { AgentTabStatus } from "@sparkle/ui";

/** A fake hook log the test appends to, served through watchHookEvents' real offset protocol. */
const mkLog = () => {
  const lines: string[] = [];
  return {
    /** The emitter writing one event. Stop calling this to simulate a clobbered emitter. */
    emit: (ev: HookEvent) => lines.push(JSON.stringify(ev)),
    /** How many lines the emitter has written — the target for `drained()`. ASSUMES every emitted
     *  line PARSES: watchHookEvents drops anything parseHookLine rejects without calling onEvent,
     *  so a deliberately-malformed line would stop `dispatched` ever reaching this count and
     *  `drained()` would spin to vitest's timeout, failing as "expected 2 to be 3" — which reads
     *  like a dispatch bug, not an intentionally-unparseable line. Every line here comes from
     *  JSON.stringify, so that holds today. If you add a malformed-line case, give `drained()` an
     *  explicit expected-dispatch count instead of using this. */
    count: () => lines.length,
    poll: async (_path: string, offset: number) => ({
      lines: lines.slice(offset),
      offset: lines.length,
    }),
  };
};

/** Stand up the real wiring exactly as AgentPane does, with an injected clock. */
const mkPipeline = () => {
  const emitted: AgentTabStatus[] = [];
  const log = mkLog();
  let t = 0;
  const router: StatusRouter = createStatusRouter((s) => emitted.push(s), () => t);
  const engine = new HookStatusEngine({ agentId: "a1", onStatus: (s) => router.fromHook(s) });
  const captureHistory = vi.fn();
  const handler = createHookEventHandler({
    engine,
    activate: () => router.activate(),
    captureHistory,
  });
  // Count DISPATCHES, not statuses — see `drained`.
  let dispatched = 0;
  const watcher = watchHookEvents(
    "/fake/agent.jsonl",
    (ev) => {
      dispatched++;
      handler(ev);
    },
    { intervalMs: 1, poll: log.poll, skipExisting: false },
  );
  // Block until the watcher has DISPATCHED every line the emitter wrote. This is the only sound
  // wait here, for two reasons:
  //  - A duration guess flakes under a concurrent runner. Worse, in the negative tests (a foreign
  //    event must change NOTHING) it fails OPEN: if the poll hasn't run, "nothing happened" holds
  //    trivially and the test passes while never exercising the hazard at all.
  //  - Waiting on a STATUS is also unsound: HookStatusEngine dedups, so a line that maps to the
  //    status already showing (PreToolUse after UserPromptSubmit — both "working") emits nothing.
  //    The wait would be satisfied with that line still undrained, leaving the scenario the test
  //    claims to set up not actually established.
  // Dispatch count has neither problem: it is positive, monotonic, and true of every event.
  const drained = () => vi.waitFor(() => expect(dispatched).toBe(log.count()));
  return {
    emitted,
    log,
    router,
    watcher,
    captureHistory,
    drained,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

describe("hook outage — the founder's bug, end to end", () => {
  it("a dead hook stream + a working screen turns the row GREEN, not red", async () => {
    // The exact reported scenario: the agent asked "Want me to start on the self-test?", the user
    // answered "yes", and the agent resumed — transcript showed tool calls and a live spinner — but
    // the sidebar row stayed RED.
    const p = mkPipeline();
    try {
      // 1. A turn runs and ends with the agent asking a question.
      p.log.emit({ event: "UserPromptSubmit", session_id: "main", prompt: "build the thing" });
      p.log.emit({ event: "Stop", session_id: "main" });
      await p.drained();
      expect(p.emitted.at(-1)).toBe("idle");

      // 2. The followup judge reads the finished turn and decides the agent is blocked on the user.
      //    This is correct so far — the row SHOULD be red here.
      p.router.fromJudge("waiting");
      expect(p.emitted.at(-1)).toBe("waiting");

      // 3. THE OUTAGE. The emitter is clobbered out of .claude/settings.local.json (an "always
      //    allow" grant, /permissions, the agent editing the file). Claude Code read that file at
      //    startup, so nothing re-arms it: no further events are ever written. Note we do NOT emit
      //    the UserPromptSubmit for the user's "yes" — that event is exactly what got lost.
      p.advance(HOOK_STALE_MS + 1);

      // 4. The agent IS running, and the screen scraper — the only witness left — can see it.
      p.router.fromScreen("working");

      // The row must go green. Before this branch it stayed red forever: lastJudge had no clear
      // path but a hook event, and hooksLive was latched true so resolve() kept answering the
      // frozen hook "idle".
      expect(p.emitted.at(-1)).toBe("working");
    } finally {
      p.watcher.stop();
    }
  });

  it("recovers authority to hooks when the emitter is restored on the next spawn", async () => {
    // The other half of the story: reinstall on prepare re-adds the emitter (pinned in Rust by
    // reinstall_restores_a_clobbered_emitter_and_keeps_the_user_keys), events start flowing again,
    // and hooks must take the status back from the scraper.
    const p = mkPipeline();
    try {
      p.log.emit({ event: "Stop", session_id: "main" });
      await p.drained();
      expect(p.emitted.at(-1)).toBe("idle"); // the turn really did close gray before the judge runs
      p.router.fromJudge("waiting");
      p.advance(HOOK_STALE_MS + 1);
      p.router.fromScreen("working"); // outage → scraper has authority
      expect(p.emitted.at(-1)).toBe("working");

      // Emitter restored; the agent finishes a turn. Hooks own the status again, so the row settles
      // gray off a real Stop rather than staying on the scraper's guess.
      p.log.emit({ event: "UserPromptSubmit", session_id: "main" });
      p.log.emit({ event: "Stop", session_id: "main" });
      await p.drained();
      expect(p.emitted.at(-1)).toBe("idle");
    } finally {
      p.watcher.stop();
    }
  });

  it("a background claude in the same worktree cannot red the row or hold the clock open", async () => {
    // The shared-log hazard, end to end. A background one-shot `claude` runs in the same worktree
    // and its events land in the SAME log. They must drive nothing: not history (its Stop would be
    // judged onto this row), and not the liveness clock (a chatty background session would keep
    // lastHookAt fresh and defeat the watchdog exactly when the main stream is dead).
    const p = mkPipeline();
    try {
      p.log.emit({ event: "UserPromptSubmit", session_id: "main" }); // locks onto "main"
      p.log.emit({ event: "Stop", session_id: "main" });
      await p.drained();
      expect(p.emitted.at(-1)).toBe("idle"); // baseline gray, so the judge's red below is real
      p.captureHistory.mockClear();
      p.router.fromJudge("waiting"); // red, correctly

      // The main stream dies here. A background claude keeps chattering the whole time.
      for (let i = 0; i < 4; i++) {
        p.advance(HOOK_STALE_MS / 2);
        p.log.emit({ event: "PreToolUse", session_id: "bg", tool: "Bash" });
        p.log.emit({ event: "Stop", session_id: "bg" });
        // Wait for these lines to be DISPATCHED before asserting they changed nothing — otherwise
        // "nothing happened" would be trivially true of an un-polled watcher and the test would
        // pass without ever exercising the hazard.
        await p.drained();
        expect(p.emitted.at(-1)).toBe("waiting");
      }
      expect(p.captureHistory).not.toHaveBeenCalled(); // never drove history/judge dispatch

      // ...and it did not hold the liveness clock open: the watchdog still fires for the MAIN
      // session's dead stream, so the row goes green.
      p.router.fromScreen("working");
      expect(p.emitted.at(-1)).toBe("working");
    } finally {
      p.watcher.stop();
    }
  });

  it("a healthy long tool call keeps hook authority — no false handback", async () => {
    // The regression roborev caught (job 37949). A single long build is silent past the window while
    // the screen says working, but hooks are alive and the turn is OPEN, so authority must not move.
    const p = mkPipeline();
    try {
      p.log.emit({ event: "UserPromptSubmit", session_id: "main" });
      p.log.emit({ event: "PreToolUse", session_id: "main", tool: "Bash" }); // a 5-minute build
      // drained(), not a status wait: PreToolUse dedups against the prompt's "working", so a status
      // wait would resolve with the tool call still undrained — i.e. the open-tool-call premise this
      // test rests on would not actually be established.
      await p.drained();
      expect(p.emitted.at(-1)).toBe("working");

      p.advance(HOOK_STALE_MS * 10);
      // This tick is what actually drives the watchdog predicate — it is gated on s === "working",
      // so a scraper tick of any other status would never evaluate the handback at all.
      p.router.fromScreen("working");
      // ...and this one discriminates the outcome. On its own the line above is vacuous, since a
      // false handback ALSO emits "working". If the handback wrongly fired, hooksLive is now false
      // and the scraper owns the row, so this misread leaks out as a false red.
      p.router.fromScreen("waiting"); // a transient screen misread mid-build
      // Hooks still own it, so the misread is suppressed and the row stays green.
      expect(p.emitted.at(-1)).toBe("working");
    } finally {
      p.watcher.stop();
    }
  });
});
