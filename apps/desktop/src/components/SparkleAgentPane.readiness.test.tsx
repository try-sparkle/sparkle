// @vitest-environment jsdom
//
// WITH NO COMPOSER, THIS PANE HAS TO JOIN THE REGISTRIES THE CONCIERGE SEND PATH READS.
//
// The Improve Sparkle pane never registered with paneReadiness or paneControl, and that was harmless
// only while it owned a `<Composer preparing={!ptyReady}>`: the composer WAS this pane's queue (it
// held an eager send and flushed it on preparing→ready) and its `onRestartAgent` WAS this pane's
// dead-PTY heal. Stripping the composer so Improve Sparkle mounts like every other build agent
// removed both, and left the pane publishing nothing — so `paneState()` stayed "unmounted" forever,
// `wasStarting` in conciergeDispatch was always false, and a prompt sent while the pane was still
// coming up (worktree creation → repo prepare → Claude preflight, all slow) hard-failed as
// `pty-gone` and was discarded instead of held. The concierge's own remedy copy — "Start it again and
// I'll pass it along" — also became an instruction the user could not follow, because `restartPane`
// had nothing registered for this agent. (roborev 55564.)
//
// So these are not "does the pane call a function" assertions: each one is read through the registry
// the SEND PATH consults, in the state that decides queue-vs-fail.
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  terminal: [] as Array<{ onReady?: () => void; onSpawnFailed?: () => void }>,
  prepareCalls: { n: 0 },
}));

vi.mock("./Terminal", async (importOriginal) => {
  const real = await importOriginal<typeof import("./Terminal")>();
  return {
    ...real,
    Terminal: (props: { onReady?: () => void; onSpawnFailed?: () => void }) => {
      captured.terminal.push(props);
      return null;
    },
  };
});
vi.mock("./Composer", () => ({ Composer: () => null }));
// The PTY, for the end-to-end queue case at the bottom. `submitPrompt` rejects while the pane is
// still coming up (there is no process yet — the real failure mode) and succeeds afterwards, which is
// exactly the sequence the pane's readiness publication has to make legible to conciergeDispatch.
const ptyUp = vi.hoisted(() => ({ value: false }));
vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return {
    PtyGoneError,
    writePtyChainedStrict: vi.fn(async () => {}),
    submitPrompt: vi.fn(async () => {
      if (!ptyUp.value) throw new PtyGoneError("no pty");
    }),
  };
});
vi.mock("../services/terminalScrollback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/terminalScrollback")>()),
  getAgentScrollback: vi.fn(() => ""),
}));
vi.mock("../services/suggestions/heuristics", () => ({ detectTerminalPrompts: vi.fn(() => []) }));
vi.mock("../services/agentNaming", () => ({ maybeAutoName: vi.fn() }));
vi.mock("../services/trialMeter", () => ({
  recordTrialSend: vi.fn(async () => {}),
  trialSendAllowed: vi.fn(() => true),
}));
vi.mock("../services/aiGate", () => ({ aiFeatureNow: vi.fn(() => false) }));
vi.mock("./Onboarding", () => ({ Onboarding: () => null }));
vi.mock("./PinnedPrompt", () => ({ PinnedPrompt: () => null }));
vi.mock("./SparkleConsentBanner", () => ({ SparkleConsentBanner: () => null }));
vi.mock("../services/worktree", () => ({
  createAgentWorktree: vi.fn(() =>
    Promise.resolve({ path: "/wt/sparkle-self", branch: "sparkle/agent-self" }),
  ),
  installWorktreeGuard: vi.fn(() => Promise.resolve()),
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
}));
vi.mock("../preflight", () => ({
  checkClaude: vi.fn(() => Promise.resolve({ installed: true, path: "/usr/local/bin/claude" })),
  claudeHasSession: vi.fn(() => Promise.resolve(false)),
  claudeLatestSessionPath: vi.fn(() => Promise.resolve(null)),
}));
// `ensureSparkleRepo` is the first await in prepare(), which makes it the cleanest place to both stub
// the workspace and COUNT prepares — the respawn lever's whole job is to re-enter prepare().
vi.mock("../services/sparkleAgent", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/sparkleAgent")>();
  return {
    ...real,
    ensureSparkleRepo: vi.fn(() => {
      captured.prepareCalls.n += 1;
      return Promise.resolve({
        repoPath: "/app-data/",
        logDir: "/app-data/logs/sparkle",
        defaultBranch: "main",
      });
    }),
  };
});

import { SparkleAgentPane } from "./SparkleAgentPane";
import { paneState, resetPaneReadiness } from "../services/paneReadiness";
import { clearPaneRestarts, restartPane } from "../services/paneControl";
import {
  dispatchConciergeAnswer,
  onDeferredSendOutcome,
  type ConciergeDispatchResult,
} from "../services/conciergeDispatch";
import { resetPendingSends } from "../services/pendingSends";
import { submitPrompt } from "../pty";

const SPARKLE_ID = "__sparkle_self__";

/** Any valid authority — these cases exercise DELIVERY, not the authorization gate. */
const TEST_AUTHORITY = { kind: "suggestion", agentId: SPARKLE_ID } as const;

beforeEach(() => {
  captured.terminal.length = 0;
  captured.prepareCalls.n = 0;
  ptyUp.value = false;
  resetPaneReadiness();
  clearPaneRestarts();
  resetPendingSends();
  vi.mocked(submitPrompt).mockClear();
});
afterEach(() => {
  cleanup();
  resetPaneReadiness();
  clearPaneRestarts();
});

/** Mount the pane and wait until prepare() has produced a spawn (Terminal rendered). */
async function mountPane() {
  const view = render(<SparkleAgentPane visible agentId={SPARKLE_ID} />);
  await waitFor(() => expect(captured.terminal.length).toBeGreaterThan(0));
  return view;
}

/** Report the spawn chain REJECTED, the way the real Terminal does — without touching `phase`. */
async function reportSpawnFailed() {
  await act(async () => {
    captured.terminal[captured.terminal.length - 1]!.onSpawnFailed?.();
  });
}

/** Report the PTY up, the way the real Terminal does. */
async function reportReady() {
  await act(async () => {
    captured.terminal[captured.terminal.length - 1]!.onReady?.();
  });
}

describe("SparkleAgentPane — the send path can tell starting from gone", () => {
  it("publishes `starting` while the workspace and PTY are coming up", async () => {
    // This is the state that makes conciergeDispatch QUEUE a prompt instead of failing it. Before the
    // pane registered, it read `unmounted` — the reading that discards the user's message.
    await mountPane();
    expect(paneState(SPARKLE_ID)).toBe("starting");
  });

  it("publishes `ready` once the PTY is up", async () => {
    // And this is what stops a LATER failure being mistaken for "still starting" and re-queued: an
    // agent whose process exited must fail truthfully.
    await mountPane();
    await reportReady();
    expect(paneState(SPARKLE_ID)).toBe("ready");
  });

  it("publishes `failed`, not `starting`, when the pane gives up", async () => {
    // A prompt sent AFTER the pane settled here must fail rather than re-queue into a hold nobody
    // will drain (roborev 46924).
    const { checkClaude } = await import("../preflight");
    (checkClaude as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      installed: false,
      path: null,
    });

    render(<SparkleAgentPane visible agentId={SPARKLE_ID} />);
    await waitFor(() => expect(paneState(SPARKLE_ID)).toBe("failed"));
  });

  // THE TERMINAL'S OWN REJECTION NEVER TOUCHES `phase`, so before this pane wired `onSpawnFailed` it
  // stayed published `starting` forever and every concierge send queued against a launch that had
  // already failed — the re-queue-and-dangle shape the `failed` state exists to prevent, reached by a
  // path the phase-driven effects cannot see.
  it("publishes `failed` when the TERMINAL rejects, not just when prepare() gives up", async () => {
    await mountPane();
    await reportReady();
    expect(paneState(SPARKLE_ID)).toBe("ready");
    await reportSpawnFailed();
    expect(paneState(SPARKLE_ID)).toBe("failed");
  });

  // …and a retry recovers. `ptyReady` is ALREADY true here, so `setPtyReady(true)` is a no-op and
  // React bails out of the re-render: only clearing the gave-up latch on ready can republish, which
  // is exactly what a prepare()-only clear would miss (Terminal's "Start again" never re-enters it).
  it("recovers to `ready` when a retry succeeds after a terminal rejection", async () => {
    await mountPane();
    await reportReady();
    await reportSpawnFailed();
    expect(paneState(SPARKLE_ID)).toBe("failed");
    await reportReady();
    expect(paneState(SPARKLE_ID)).toBe("ready");
  });

  it("drops its entry on unmount, so a send fails truthfully instead of queueing", async () => {
    const { unmount } = await mountPane();
    await reportReady();
    expect(paneState(SPARKLE_ID)).toBe("ready");

    unmount();

    expect(paneState(SPARKLE_ID)).toBe("unmounted");
  });
});

describe("SparkleAgentPane — the respawn lever the concierge's remedy copy names", () => {
  it("registers one, so restartPane can actually reach this agent", async () => {
    // `restartPane` returning false is what made "Start it again and I'll pass it along" an
    // instruction with no affordance behind it. The assertion is the RETURN, not the registration:
    // a registered-but-broken lever would still read as present.
    await mountPane();
    expect(restartPane(SPARKLE_ID)).toBe(true);
  });

  it("re-enters prepare() rather than only bouncing the terminal", async () => {
    // `Terminal.restart()` alone re-reads the `args` PROP, which still holds the exec string built by
    // the LAST prepare (consent mode, --add-dir, resume-vs-fresh all baked in). Only prepare()
    // rebuilds it, so that is what the lever must call.
    await mountPane();
    const before = captured.prepareCalls.n;

    await act(async () => {
      restartPane(SPARKLE_ID);
    });

    expect(captured.prepareCalls.n).toBe(before + 1);
  });

  it("unregisters on unmount", async () => {
    const { unmount } = await mountPane();
    unmount();
    expect(restartPane(SPARKLE_ID)).toBe(false);
  });
});

// ── THE WHOLE POINT, END TO END ───────────────────────────────────────────────────────────────
//
// The registry cases above are the mechanism; this is the user's outcome. "Open Improve Sparkle and
// immediately tell it what to do" is the ordinary way in now that the row mounts the concierge, and
// this pane's start-up is slow (worktree creation → repo prepare → Claude preflight). Before the
// readiness publication, that prompt hard-failed as `pty-gone` and was thrown away. It must be HELD
// and then DELIVERED — the delivery is the assertion, not the queueing.
describe("SparkleAgentPane — a prompt sent during start-up is held, then delivered", () => {
  it("queues while starting instead of failing as pty-gone", async () => {
    await mountPane();

    const res = await dispatchConciergeAnswer(SPARKLE_ID, "review the last hour of logs", {
      authority: TEST_AUTHORITY,
      userPrompt: true,
    });

    expect(res.path).toBe("queued");
  });

  // ── OBSERVE THE OUTCOME, NOT THE CALL ──────────────────────────────────────────────────────
  //
  // `onDeferredSendOutcome` is the ONLY channel by which the concierge reconciles the "I'll send that
  // the moment it's ready" it already said out loud. So it — not `submitPrompt`'s call record, not the
  // queue length — is the user-visible result of a queued send, and the thing these two cases have to
  // assert. Both originally asserted one layer below that and both were provably weaker for it
  // (roborev 55598):
  //
  //  • "delivered" checked only that submitPrompt was CALLED with the text. `flushPendingSends`
  //    catches PtyGoneError and turns it into an `{ok: false, path: "pty-gone"}` outcome, so a flush
  //    that attempts and RE-FAILS — exactly what a ptyReady-vs-PTY-liveness ordering bug produces,
  //    which is the bug this pane's readiness publication exists to prevent — left an identical
  //    mock.calls array and passed. Deleting the `ptyUp.value = true` line passed too.
  //  • "reports" checked only that the queue emptied — the one thing the correct AND the broken
  //    implementation both do. Swapping `abandonPendingSends` for `clearPendingSends` (the silent drop
  //    roborev 46311 was filed against, and one token away since both are exported) kept the queue at
  //    0 and ALL TEN CASES GREEN while the user's promised prompt vanished without a word. Verified.
  //
  // The difference between those two functions is exclusively the `emitOutcome({path: "abandoned"})`
  // loop, which is precisely why the outcome is the assertion and the count is corroboration.
  const collectOutcomes = () => {
    const seen: ConciergeDispatchResult[] = [];
    const off = onDeferredSendOutcome((r) => seen.push(r));
    return { seen, off };
  };

  it("delivers it once the PTY comes up", async () => {
    await mountPane();
    await dispatchConciergeAnswer(SPARKLE_ID, "review the last hour of logs", {
      authority: TEST_AUTHORITY,
      userPrompt: true,
    });
    // The first (failed) attempt is the one that queued it. Nothing has landed yet.
    vi.mocked(submitPrompt).mockClear();
    const { seen, off } = collectOutcomes();

    try {
      ptyUp.value = true;
      await reportReady();
      // The pane's flush effect is fire-and-forget, so let its promise chain settle.
      await act(async () => {
        await Promise.resolve();
      });

      // THE OUTCOME: a successful delivery, not merely an attempt.
      expect(seen).toEqual([
        expect.objectContaining({
          ok: true,
          path: "free-text",
          agentId: SPARKLE_ID,
          sent: "review the last hour of logs",
        }),
      ]);
      // Corroboration: it went out over the PTY rather than being reported without being sent.
      expect(vi.mocked(submitPrompt).mock.calls.map((c) => c[1])).toContain(
        "review the last hour of logs",
      );
    } finally {
      off();
    }
  });

  // …AND THROUGH THE TERMINAL'S OWN REJECTION, which reaches the same give-up state by a route the
  // arm below never travels. Without this, deleting `gaveUp ||` from the ABANDON effect leaves both
  // readiness arms green — `failed` is published by the OTHER effect — while a prompt held during
  // start-up dangles with nothing ever reporting it. That is the silent-drop shape this file already
  // pins for the phase path, and its comment there records that a weaker assertion (queue length
  // instead of the outcome) kept all ten cases green while the user's promised prompt vanished. So
  // this asserts the OUTCOME, with the count only as corroboration.
  it("REPORTS a held prompt when the TERMINAL rejects, not only when prepare() gives up", async () => {
    await mountPane();
    await dispatchConciergeAnswer(SPARKLE_ID, "review the last hour of logs", {
      authority: TEST_AUTHORITY,
      userPrompt: true,
    });
    const { pendingSendCount } = await import("../services/pendingSends");
    expect(pendingSendCount(SPARKLE_ID)).toBe(1);
    const { seen, off } = collectOutcomes();

    try {
      await reportSpawnFailed();
      await waitFor(() => expect(paneState(SPARKLE_ID)).toBe("failed"));
      expect(seen).toEqual([
        expect.objectContaining({
          ok: false,
          path: "abandoned",
          agentId: SPARKLE_ID,
          sent: "review the last hour of logs",
        }),
      ]);
      expect(pendingSendCount(SPARKLE_ID)).toBe(0);
    } finally {
      off();
    }
  });

  it("REPORTS a held prompt rather than losing it when the pane gives up", async () => {
    // A spawn that fails never flips ptyReady, so nothing would ever drain the hold. The pane has to
    // SAY SO rather than go quiet (roborev 46311) — the promise it is reconciling was made out loud.
    await mountPane();
    await dispatchConciergeAnswer(SPARKLE_ID, "review the last hour of logs", {
      authority: TEST_AUTHORITY,
      userPrompt: true,
    });
    const { pendingSendCount } = await import("../services/pendingSends");
    expect(pendingSendCount(SPARKLE_ID)).toBe(1);
    const { seen, off } = collectOutcomes();

    try {
      const { checkClaude } = await import("../preflight");
      vi.mocked(checkClaude).mockResolvedValueOnce({ installed: false, path: null } as never);
      await act(async () => {
        restartPane(SPARKLE_ID); // re-enters prepare(), which now finds no Claude → phase "no-claude"
      });
      await waitFor(() => expect(paneState(SPARKLE_ID)).toBe("failed"));

      // THE OUTCOME: the user is told the prompt did not go. A silent drop empties the queue too.
      expect(seen).toEqual([
        expect.objectContaining({
          ok: false,
          path: "abandoned",
          agentId: SPARKLE_ID,
          sent: "review the last hour of logs",
        }),
      ]);
      expect(pendingSendCount(SPARKLE_ID)).toBe(0);
    } finally {
      off();
    }
  });
});
