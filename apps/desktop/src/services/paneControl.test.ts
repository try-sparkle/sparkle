import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerPaneRestart,
  unregisterPaneRestart,
  restartPane,
  restartPaneAwaited,
  registerPaneAccount,
  unregisterPaneAccount,
  paneAccountMap,
  busiestPaneAccount,
  clearPaneRestarts,
  type PaneRestartResult,
} from "./paneControl";
import {
  setPaneReady,
  setPaneFailed,
  resetPaneReadiness,
  notePaneRelaunch,
  unregisterPane,
} from "./paneReadiness";

beforeEach(() => clearPaneRestarts());

describe("pane restart registry", () => {
  it("restarts a registered pane", () => {
    const fn = vi.fn();
    registerPaneRestart("x", fn);
    expect(restartPane("x")).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("is a no-op — not an error — for an agent with no mounted pane", () => {
    // A closed agent still gets its pin; it picks up the new account on its next spawn.
    expect(restartPane("gone")).toBe(false);
  });

  it("stops restarting after unregister (unmount)", () => {
    const fn = vi.fn();
    registerPaneRestart("x", fn);
    unregisterPaneRestart("x");
    expect(restartPane("x")).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("contains a throwing restart rather than propagating it", () => {
    registerPaneRestart("x", () => {
      throw new Error("boom");
    });
    expect(restartPane("x")).toBe(false);
  });
});

// ── restartPaneAwaited ──────────────────────────────────────────────────────────────────────────
//
// `restartPane` returns at DISPATCH: the pane's lever is `() => prepare()`, prepare is async, and
// the boolean says only "a lever was registered and did not throw synchronously". A caller that
// reports success on that is telling the human the agent restarted when nothing has happened yet —
// measured on v0.107.0, where three `restart_agent` calls all returned ok while an immediate status
// re-read still showed every one of them `errored`.
//
// Worse, `prepare()` CATCHES ITS OWN FAILURES (AgentPane sets phase "error"/"no-claude" and
// resolves normally), so awaiting alone still cannot tell a spawn that worked from one that did
// not. The lever therefore reports its terminal phase, and this is what reads it.
describe("restartPaneAwaited", () => {
  const fast = { readyTimeoutMs: 400, pollMs: 5 };

  /** A lever for a runtime that genuinely re-spawns. It announces the relaunch exactly as
   *  AgentPane/SparkleAgentPane's prepare() does — synchronously, before any await — then does
   *  whatever the case needs and reports its phase. */
  const relaunching = (body: () => void = () => {}, phase: unknown = "ready") =>
    async () => {
      notePaneRelaunch("x");
      body();
      return phase;
    };

  beforeEach(() => resetPaneReadiness());

  it("reports no-pane when nothing is mounted, without inventing a success", async () => {
    await expect(restartPaneAwaited("gone", fast)).resolves.toBe("no-pane");
  });

  it("waits for the async lever to FINISH before answering", async () => {
    let finished = false;
    registerPaneRestart("x", async () => {
      notePaneRelaunch("x");
      await Promise.resolve();
      finished = true;
      setPaneReady("x", true);
      return "ready";
    });
    const r = await restartPaneAwaited("x", fast);
    // The assertion `restartPane` cannot make: the work is done by the time we answer.
    expect(finished).toBe(true);
    expect(r).toBe("restarted");
  });

  it("reports spawn-failed when prepare RESOLVES having failed — the false-success case", async () => {
    // prepare() swallows its own error and resolves; only the phase distinguishes it.
    registerPaneRestart("x", relaunching(() => {}, "error"));
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("spawn-failed");
  });

  it("reports no-claude distinctly, because that failure has its own remedy", async () => {
    registerPaneRestart("x", relaunching(() => {}, "no-claude"));
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("no-claude");
  });

  it("reports threw for an ASYNC rejection — the one restartPane silently discards", async () => {
    registerPaneRestart("x", () => Promise.reject(new Error("boom")));
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("threw");
  });

  it("reports threw for a synchronous throw too", async () => {
    registerPaneRestart("x", () => {
      throw new Error("boom");
    });
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("threw");
  });

  // ── THE PHASE IS NOT THE ANSWER ───────────────────────────────────────────────────────────────
  //
  // phase "ready" means the spawn command was ASSEMBLED. `Terminal` execs the PTY afterwards, and
  // that path's failure never touches phase — it publishes paneReadiness `failed`. A verdict built
  // on the phase therefore calls a launch that died at PTY spawn "restarted", which is the same
  // false success this whole function exists to close, one door over.

  it("reports spawn-failed when the phase says ready but the PANE gave up", async () => {
    registerPaneRestart("x", relaunching(() => setPaneFailed("x")));
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("spawn-failed");
  });

  it("reports timed-out when the phase says ready but the PTY never comes up", async () => {
    registerPaneRestart("x", relaunching(() => setPaneReady("x", false)));
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("timed-out");
  });

  it("answers restarted only once the pane REACHES ready, not while it is still starting", async () => {
    registerPaneRestart(
      "x",
      relaunching(() => {
        setPaneReady("x", false);
        setTimeout(() => setPaneReady("x", true), 20);
      }),
    );
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("restarted");
  });

  it("reports no-pane when the pane unmounts underneath the restart", async () => {
    setPaneReady("x", true);
    registerPaneRestart("x", relaunching(() => unregisterPane("x")));
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("no-pane");
  });

  // ── NO DEFAULTED SUCCESS ──────────────────────────────────────────────────────────────────────
  //
  // A lever that reports nothing must not shortcut to "restarted" — that is the "defaulted seam
  // every test injects" shape, and it would let either real registrant silently regress to the old
  // `() => void prepare()` with this suite still green.

  it("does NOT treat a lever that reports nothing as a success", async () => {
    registerPaneRestart("x", () => {
      notePaneRelaunch("x");
      setPaneReady("x", false); // re-spawning, and it never comes up
    });
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("timed-out");
  });

  it("still answers restarted for a silent lever when the pane really did come up", async () => {
    registerPaneRestart("x", () => {
      notePaneRelaunch("x");
      setPaneReady("x", true);
    });
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("restarted");
  });

  it("treats an in-flight phase as no verdict and defers to the pane, not a failure", async () => {
    // A stale-run guard returned, or a concurrent sweep re-entered prepare(): phase is "preparing".
    // The restart may well be proceeding, so refusing here would be a false NEGATIVE the concierge
    // relays to the human as an outage.
    registerPaneRestart("x", relaunching(() => setPaneReady("x", true), "preparing"));
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("restarted");
  });

  // ── A STALE `ready` IS NOT THIS RESTART'S VERDICT ─────────────────────────────────────────────
  //
  // The agent you restart is, by definition, usually one whose pane is ALREADY `ready`. Reading the
  // state at face value therefore answers with the PREVIOUS launch's verdict and calls the restart
  // done before anything happened — the same false success, third time around (roborev 64084). The
  // reading only counts once the pane has published again.

  it("does NOT accept the readiness left over when the teardown lands just after prepare", async () => {
    // THE SHARP CASE. The pane is already `ready`, and the teardown publishes `starting` a few ms
    // AFTER the lever resolves. Reading the state at face value answers "restarted" off the
    // previous launch's verdict.
    setPaneReady("x", true);
    registerPaneRestart(
      "x",
      relaunching(() => {
        setTimeout(() => setPaneReady("x", false), 10); // torn down, never comes back up
      }),
    );
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("timed-out");
  });

  it("accepts ready once THIS restart has published it", async () => {
    setPaneReady("x", true);
    registerPaneRestart(
      "x",
      relaunching(() => {
        setPaneReady("x", false);
        setTimeout(() => setPaneReady("x", true), 20);
      }),
    );
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("restarted");
  });

  it("does not mistake a stale ready for success when the new launch then FAILS", async () => {
    setPaneReady("x", true);
    registerPaneRestart(
      "x",
      relaunching(() => {
        setPaneReady("x", false);
        setTimeout(() => setPaneFailed("x"), 20);
      }),
    );
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("spawn-failed");
  });

  // ── A RE-PREPARE THAT RE-SPAWNS NOTHING IS NOT A RESTART ──────────────────────────────────────
  //
  // Shell and cloud agents take an early return: prepare() rebuilds config, Terminal is never
  // remounted, the PTY is never replaced. The pane may well be `ready` throughout — it never
  // stopped — but nothing was restarted, and saying "restarted" would report an action that did
  // not happen. It gets its own outcome so the caller can say what is true.

  it("reports nothing-to-restart when no re-spawn was announced, even on a healthy pane", async () => {
    setPaneReady("x", true);
    registerPaneRestart("x", async () => "ready"); // no notePaneRelaunch: nothing re-spawned
    await expect(restartPaneAwaited("x", fast)).resolves.toBe("nothing-to-restart");
  });

  // ── A LEVER THAT NEVER RESOLVES ───────────────────────────────────────────────────────────────
  //
  // `prepare()` awaits worktree creation, guard install, workspace integrity, claude preflight and
  // the orchestration bridge — all Tauri round-trips that can stall on a locked repo or a hung
  // `git worktree add`. Awaiting it unconditionally wedges the caller forever with no verdict, the
  // same "no answer the caller can act on" failure this whole function exists to close.
  it("bounds the LEVER itself, not just the wait after it", async () => {
    registerPaneRestart("x", () => new Promise(() => {})); // never settles
    const t0 = Date.now();
    await expect(restartPaneAwaited("x", { readyTimeoutMs: 100, pollMs: 5 })).resolves.toBe(
      "timed-out",
    );
    // Tight on purpose. Generous slack here would stay green against almost any bound regression,
    // which is how the double-spend below went unnoticed in the first place.
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it("spends ONE budget across both phases, not one each", async () => {
    // ON FAKE TIMERS, ON PURPOSE. The property under test — is `deadline` computed once or twice —
    // is pure arithmetic with no genuine timing content, so discriminating it by measured wall
    // clock would mean tuning a bound between ~200ms and ~380ms and hoping a loaded CI worker stays
    // inside it. That is a flake, and widening it back re-opens the hole it was written to close.
    // Advancing a fake clock by EXACTLY the budget answers the question deterministically.
    vi.useFakeTimers();
    try {
      registerPaneRestart("x", async () => {
        notePaneRelaunch("x");
        setPaneReady("x", false); // re-spawning, and it never comes up
        await new Promise((r) => setTimeout(r, 180)); // nearly the whole budget spent in the lever
        return "ready";
      });

      let settled: PaneRestartResult | undefined;
      void restartPaneAwaited("x", { readyTimeoutMs: 200, pollMs: 5 }).then((r) => (settled = r));

      // Part-way through the single budget: no verdict yet.
      await vi.advanceTimersByTimeAsync(150);
      expect(settled).toBeUndefined();

      // At the budget: it must be done. A fresh deadline after the lever would need 180 + 200 and
      // would still be waiting here, which is exactly the regression this pins.
      await vi.advanceTimersByTimeAsync(60);
      expect(settled).toBe("timed-out");
    } finally {
      vi.useRealTimers();
    }
  });

  // Deliberately not "eventually": a re-prepare that re-spawns nothing is knowable the moment the
  // lever resolves, so making the caller wait out the readiness budget for it would be its own
  // small outage. (Sits after the budget tests only because it shares their subject.)
  it("answers nothing-to-restart immediately, without spending the ready timeout", async () => {
    setPaneReady("x", true);
    registerPaneRestart("x", async () => "ready");
    const t0 = Date.now();
    await restartPaneAwaited("x", { readyTimeoutMs: 5_000, pollMs: 5 });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("pane account registry", () => {
  it("maps live agents to their accounts", () => {
    registerPaneAccount("x", "a");
    registerPaneAccount("y", "b");
    expect(paneAccountMap()).toEqual({ x: "a", y: "b" });
    unregisterPaneAccount("x");
    expect(paneAccountMap()).toEqual({ y: "b" });
  });

  it("busiestPaneAccount picks the account most agents are on", () => {
    registerPaneAccount("x", "a");
    registerPaneAccount("y", "a");
    registerPaneAccount("z", "b");
    expect(busiestPaneAccount()).toBe("a");
  });

  it("busiestPaneAccount is null when nothing is running", () => {
    expect(busiestPaneAccount()).toBeNull();
  });

  it("busiestPaneAccount breaks ties deterministically", () => {
    registerPaneAccount("x", "b");
    registerPaneAccount("y", "a");
    expect(busiestPaneAccount()).toBe("a");
    expect(busiestPaneAccount()).toBe("a"); // stable across calls
  });

  it("a re-spawn onto a new account overwrites the old entry", () => {
    // This is how a completed switch is reflected: the pane re-registers with its new account.
    registerPaneAccount("x", "a");
    registerPaneAccount("x", "b");
    expect(paneAccountMap()).toEqual({ x: "b" });
    expect(busiestPaneAccount()).toBe("b");
  });
});
