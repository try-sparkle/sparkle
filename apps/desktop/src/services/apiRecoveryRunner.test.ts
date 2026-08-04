import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EPISODE_CARRY_MS,
  __apiRecoveryCarrySize,
  __resetApiRecovery,
  apiRecoveryEpisode,
  episodeCarryWindowMs,
  forgetAgent,
  apiRecoveryLadderCount,
  PING_BUDGET_WINDOW_MS,
  PING_BUDGET,
  MAX_LADDERS_PER_WINDOW,
  nextRetryDueAt,
  noteAgentStatus,
  sweepApiRecovery,
  type ReviveDeps,
} from "./apiRecoveryRunner";
import {
  classifyFromScrollback,
  REVIVE_LADDER_MS,
  REVIVE_PROMPT_MARKER,
  revivePrompt,
  BUDGET_SPENT_REASON,
} from "../engine/apiRecovery";

const A = "agent-1";
const T0 = 1_700_000_000_000;
const BANNER_529 = "⏺ API Error: 529 Overloaded.";
const BANNER_SPEND = "⏺ You've hit your monthly spend limit · raise it at claude.ai";

/** A dependency set whose agent is reachable and alive, with a spy for the write. */
function deps(over: Partial<ReviveDeps> = {}): ReviveDeps & { submit: ReturnType<typeof vi.fn> } {
  const submit = vi.fn(async () => {});
  return {
    now: T0 + REVIVE_LADDER_MS[0]!,
    statusOf: () => "errored",
    canAcceptInput: () => true,
    processAliveOf: () => true, // alive
    submit,
    onEscalate: vi.fn(),
    enabled: () => true,
    ...over,
    // Keep the spy reachable even when a caller overrode `submit`.
    ...(over.submit ? { submit: over.submit as ReturnType<typeof vi.fn> } : {}),
  } as ReviveDeps & { submit: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  __resetApiRecovery();
  vi.restoreAllMocks();
});

describe("noteAgentStatus", () => {
  it("opens an episode on entry into errored, classifying from the scrollback ONCE", () => {
    expect(noteAgentStatus(A, "errored", T0, () => BANNER_529)).toBe("started");
    expect(apiRecoveryEpisode(A)).toMatchObject({
      erroredSince: T0,
      attempts: 0,
      failure: "retryable",
      escalated: false,
    });
  });

  it("does not re-open or re-classify an episode already in flight", () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    // A later read would see our OWN retry prompt in the scrollback (it contains "529 Overloaded"),
    // so re-classifying per sweep would eventually judge the episode on our own echo.
    expect(noteAgentStatus(A, "errored", T0 + 5_000, () => BANNER_SPEND)).toBe("none");
    expect(apiRecoveryEpisode(A)?.failure).toBe("retryable");
    expect(apiRecoveryEpisode(A)?.erroredSince).toBe(T0);
  });

  it("closes the episode the moment the agent leaves errored — that IS the recovery signal", () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    expect(noteAgentStatus(A, "working", T0 + 6_000, () => "")).toBe("recovered");
    expect(apiRecoveryEpisode(A)).toBeUndefined();
  });

  it("is a no-op for a healthy agent it was never tracking", () => {
    expect(noteAgentStatus(A, "working", T0, () => "")).toBe("none");
    expect(apiRecoveryEpisode(A)).toBeUndefined();
  });
});

describe("sweepApiRecovery", () => {
  it("types the retry into the terminal when the rung is due, and records the attempt", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const d = deps();
    const out = await sweepApiRecovery(d);

    expect(out).toEqual([{ agentId: A, decision: { action: "ping", attempt: 1, prompt: revivePrompt(1) } }]);
    // The SIDE EFFECT, not just the decision: the prompt actually reached the PTY.
    expect(d.submit).toHaveBeenCalledOnce();
    expect(d.submit).toHaveBeenCalledWith(A, revivePrompt(1));
    expect(apiRecoveryEpisode(A)).toMatchObject({ attempts: 1, lastPingAt: d.now });
  });

  it("sends NOTHING before the first rung is due", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const d = deps({ now: T0 + REVIVE_LADDER_MS[0]! - 1 });
    await sweepApiRecovery(d);
    expect(d.submit).not.toHaveBeenCalled();
    expect(apiRecoveryEpisode(A)?.attempts).toBe(0);
  });

  // The master toggle is the user saying "do not type on my behalf". It must be checked before a
  // decision is computed, so no ping can slip through a race between the toggle and a live sweep.
  it("sends NOTHING when autonomous typing is turned off", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const d = deps({ enabled: () => false });
    expect(await sweepApiRecovery(d)).toEqual([]);
    expect(d.submit).not.toHaveBeenCalled();
    expect(apiRecoveryEpisode(A)?.attempts).toBe(0);
  });

  it("never pings a TERMINAL failure — it escalates once instead", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_SPEND);
    const onEscalate = vi.fn();
    // Not even the first rung is due, and it still escalates: a spend cap does not clear with time.
    const d = deps({ now: T0, onEscalate });

    await sweepApiRecovery(d);
    expect(d.submit).not.toHaveBeenCalled();
    expect(onEscalate).toHaveBeenCalledOnce();
    expect(onEscalate.mock.calls[0]![1]).toMatch(/ACCOUNT limit/);

    // ...and only once, however many sweeps run.
    await sweepApiRecovery(deps({ now: T0 + 60_000, onEscalate }));
    expect(onEscalate).toHaveBeenCalledOnce();
    // The episode is KEPT so the concierge can still read that we gave up on it.
    expect(apiRecoveryEpisode(A)).toMatchObject({ escalated: true, attempts: 0 });
  });

  it("walks the whole ladder, one rung per due sweep, then escalates when spent", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    let clock = T0;
    const submit = vi.fn(async () => {});
    for (let i = 0; i < REVIVE_LADDER_MS.length; i++) {
      clock += REVIVE_LADDER_MS[i]!;
      await sweepApiRecovery(deps({ now: clock, submit }));
    }
    expect(submit).toHaveBeenCalledTimes(REVIVE_LADDER_MS.length);
    expect(apiRecoveryEpisode(A)?.attempts).toBe(REVIVE_LADDER_MS.length);

    // Ladder spent → the human is told, and no further pings are sent however long we wait.
    const onEscalate = vi.fn();
    await sweepApiRecovery(deps({ now: clock + 60 * 60_000, submit, onEscalate }));
    expect(onEscalate).toHaveBeenCalledOnce();
    expect(onEscalate.mock.calls[0]![1]).toMatch(/outlasting the ladder/);
    expect(submit).toHaveBeenCalledTimes(REVIVE_LADDER_MS.length); // unchanged
  });

  // ── THE LADDER MUST SURVIVE OUR OWN PING (roborev 55433, High) ────────────────────────────────
  // `submit` is pty.submitPrompt, which calls noteUserInputForAgent → StatusEngine.noteUserInput,
  // and that CLEARS the stream-failure flag (statusEngine.ts:357-362) so a resuming agent goes green.
  // Every rung therefore produces errored → working, which naive "left errored = recovered" logic
  // read as recovery and used to delete the episode — restarting the next 529 at rung 0. The result
  // was a 5-second ping loop forever, with the tail unreachable and the escalation unfirable, during
  // exactly the sustained outage this module exists for.
  //
  // The walk test above cannot see that: it pins statusOf === "errored" across all eleven sweeps, a
  // sequence production never produces. These drive the REAL sequence instead.
  it("resumes the next rung after our own ping flips the agent green and it re-errors", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const submit = vi.fn(async () => {});

    // Rung 1 fires.
    const clock = T0 + REVIVE_LADDER_MS[0]!;
    await sweepApiRecovery(deps({ now: clock, submit }));
    expect(apiRecoveryEpisode(A)?.attempts).toBe(1);

    // Our own paste clears `errored` → the agent reads `working`...
    noteAgentStatus(A, "working", clock + 100, () => "");
    expect(apiRecoveryEpisode(A)).toBeUndefined();
    // ...and the retry 529s again a moment later. This must RESUME at rung 2, not restart at rung 1.
    noteAgentStatus(A, "errored", clock + 2_000, () => BANNER_529);
    expect(apiRecoveryEpisode(A)).toMatchObject({ attempts: 1 });

    // Rung 2 is 15s, measured from the last PING — not 5s, and not from this re-entry.
    await sweepApiRecovery(deps({ now: clock + REVIVE_LADDER_MS[1]! - 1, submit }));
    expect(submit).toHaveBeenCalledOnce(); // still only rung 1 has fired
    await sweepApiRecovery(deps({ now: clock + REVIVE_LADDER_MS[1]!, submit }));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(apiRecoveryEpisode(A)?.attempts).toBe(2);
  });

  it("still escalates under a sustained outage that flips the status on every rung", async () => {
    // The end-to-end property the High finding broke: with the real errored→working→errored cycle on
    // every rung, the ladder must still reach its end and hand off to the human.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const submit = vi.fn(async () => {});
    const onEscalate = vi.fn();
    let clock = T0;
    for (let i = 0; i < REVIVE_LADDER_MS.length; i++) {
      clock += REVIVE_LADDER_MS[i]!;
      await sweepApiRecovery(deps({ now: clock, submit, onEscalate }));
      // Our ping greens it, then the outage re-errors it — the real cycle.
      noteAgentStatus(A, "working", clock + 100, () => "");
      noteAgentStatus(A, "errored", clock + 1_000, () => BANNER_529);
    }
    expect(submit).toHaveBeenCalledTimes(REVIVE_LADDER_MS.length);
    await sweepApiRecovery(deps({ now: clock + 60 * 60_000, submit, onEscalate }));
    expect(onEscalate).toHaveBeenCalledOnce();
    expect(onEscalate.mock.calls[0]![1]).toMatch(/outlasting the ladder/);
  });

  it("starts a FRESH ladder when the agent genuinely worked in between", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const submit = vi.fn(async () => {});
    const clock: number = T0 + REVIVE_LADDER_MS[0]!;
    await sweepApiRecovery(deps({ now: clock, submit }));
    expect(apiRecoveryEpisode(A)?.attempts).toBe(1);

    // Recovered, then worked productively for well past the carry window before a NEW failure. That
    // is a new episode and must start at rung 0 — otherwise a long-lived agent's ladder is permanently
    // spent by unrelated blips hours apart.
    noteAgentStatus(A, "working", clock + 100, () => "");
    noteAgentStatus(A, "errored", clock + EPISODE_CARRY_MS + 1, () => BANNER_529);
    expect(apiRecoveryEpisode(A)).toMatchObject({ attempts: 0, lastPingAt: undefined });
  });

  // ── THE CARRY WINDOW HAS TO SCALE WITH THE RUNG IT GUARDS (roborev 55457, High) ────────────────
  it("carries the rung across a re-error LATER than the old fixed 2-minute window", async () => {
    // Deep in the ladder, our ping is followed by Claude Code's own internal backoff before the next
    // banner prints — minutes of silence with no real progress. The fixed window missed that and reset
    // `attempts` AND `escalated` to zero, dropping the episode back onto the 5s rung with escalation
    // unreachable: bug 55433 again, just with a longer period.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const submit = vi.fn(async () => {});
    let clock = T0;
    for (let i = 0; i < 7; i++) {
      clock += REVIVE_LADDER_MS[i]!;
      await sweepApiRecovery(deps({ now: clock, submit }));
      noteAgentStatus(A, "working", clock + 100, () => ""); // our own ping greens it
      noteAgentStatus(A, "errored", clock + 1_000, () => BANNER_529);
    }
    expect(apiRecoveryEpisode(A)?.attempts).toBe(7);

    // Now the SLOW re-error: ping, three minutes of silence, same outage again.
    clock += REVIVE_LADDER_MS[7]!;
    await sweepApiRecovery(deps({ now: clock, submit }));
    expect(apiRecoveryEpisode(A)?.attempts).toBe(8);
    noteAgentStatus(A, "working", clock + 100, () => "");
    const slow = 3 * 60_000;
    expect(slow).toBeGreaterThan(EPISODE_CARRY_MS); // the old constant dropped this to rung 0
    noteAgentStatus(A, "errored", clock + slow, () => BANNER_529);
    expect(apiRecoveryEpisode(A)?.attempts).toBe(8);
  });

  // ── THE CARRY MUST NOT SWALLOW A GENUINELY NEW OUTAGE (roborev 55485) ──────────────────────────
  // ── THE TERMINAL RE-SCAN IS SCOPED TO POST-PING SCROLLBACK (roborev 55517) ─────────────────────
  it("does not upgrade to terminal on a limit banner the agent merely QUOTED", async () => {
    // Our own prompt asks the agent to "say so plainly" if blocked on an account limit, so it quoting
    // the banner is a shape we INVITE. What saves this case is RECENCY, not the post-ping slice: the
    // real re-failure is a 529 printed after the quote, and the backwards scan returns the most recent
    // classifying line. (Stated precisely because mutation-checking showed this test passes with the
    // slice removed — the slice is pinned by the two tests below, not by this one.)
    //
    // Worth recording: if the quote were the LAST classifying line, we WOULD upgrade to terminal — and
    // that is correct, because an agent saying "I am blocked on an account limit" is exactly the reply
    // the prompt asks for and exactly the reason the human should be given.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const submit = vi.fn(async () => {});
    const clock = T0 + REVIVE_LADDER_MS[0]!;
    await sweepApiRecovery(deps({ now: clock, submit }));
    noteAgentStatus(A, "working", clock + 100, () => "");

    const quoted = [
      revivePrompt(1),
      "⏺ Checking — the banner I saw earlier read:",
      "  ⎿  You've hit your session limit · resets 8:40am (America/Bogota)",
      "⏺ API Error: 529 Overloaded.",
    ].join("\n");
    expect(noteAgentStatus(A, "errored", clock + 1_000, () => quoted)).toBe("resumed");
    expect(apiRecoveryEpisode(A)?.failure).toBe("retryable");
  });

  it("ignores a STALE limit banner from before our ping when the re-entry is not an API failure", async () => {
    // A wedge or a process exit re-enters `errored` with no new banner at all. Un-scoped, the most
    // recent classifying line in the tail was a limit banner from earlier in the session — which the
    // original carry correctly ignored — so the episode flipped to terminal and asserted a spend cap
    // that had already reset. Slicing at our own marker drops everything that predates the ping.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const submit = vi.fn(async () => {});
    const clock = T0 + REVIVE_LADDER_MS[0]!;
    await sweepApiRecovery(deps({ now: clock, submit }));
    noteAgentStatus(A, "working", clock + 100, () => "");

    const stale = [
      "⏺ You've hit your session limit · resets 8:40am (America/Bogota)",
      "⏺ ...much later, after the limit reset, work resumed.",
      revivePrompt(1),
      "Are you there? Are you there?", // a wedge, not a banner
    ].join("\n");
    noteAgentStatus(A, "errored", clock + 1_000, () => stale);
    expect(apiRecoveryEpisode(A)?.failure).toBe("retryable");
  });

  // ── THE MARKER SLICE MUST SURVIVE ROW WRAPPING (roborev 55534) ─────────────────────────────────
  // `terminalScrollback` builds its string as one entry per xterm BUFFER ROW
  // (`translateToString(true)` joined with \r\n), and this feature already documents that a ~62-char
  // banner arrives split in two because Sparkle runs agents in narrow grid panes. A raw `lastIndexOf`
  // on a 24-char marker sitting mid-paragraph therefore returned -1 whenever a row boundary fell
  // inside it, `sinceOurPing` returned "", and the terminal upgrade SILENTLY stopped working — with
  // every test still green, because they all fed the prompt as one unwrapped line.
  const wrapAt = (text: string, cols: number): string[] => {
    const rows: string[] = [];
    for (let i = 0; i < text.length; i += cols) rows.push(text.slice(i, i + cols));
    return rows;
  };

  it("upgrades to terminal even when our marker is SPLIT across wrapped rows", () => {
    // Prove the premise first: at these widths the marker really is broken mid-word, so a raw
    // substring search cannot find it. Without this the test could pass on an unwrapped shape.
    for (const cols of [30, 37, 40, 41, 52]) {
      const rows = wrapAt(revivePrompt(1), cols);
      const joined = rows.join("\r\n");
      const split = !joined.includes(REVIVE_PROMPT_MARKER);

      __resetApiRecovery();
      noteAgentStatus(A, "errored", T0, () => BANNER_529);
      const ep = apiRecoveryEpisode(A) as { attempts: number; lastPingAt: number | undefined };
      Object.assign(ep, { attempts: 1, lastPingAt: T0 + 1_000 });
      noteAgentStatus(A, "working", T0 + 1_100, () => "");
      noteAgentStatus(A, "errored", T0 + 2_000, () => [joined, BANNER_SPEND].join("\r\n"));
      expect(apiRecoveryEpisode(A)?.failure, `cols=${cols} (marker split: ${split})`).toBe("terminal");
    }
    // At least one of those widths must actually have split the marker, or this proves nothing.
    const anySplit = [30, 37, 40, 41, 52].some(
      (c) => !wrapAt(revivePrompt(1), c).join("\r\n").includes(REVIVE_PROMPT_MARKER),
    );
    expect(anySplit).toBe(true);
  });

  it("refuses to upgrade at all when our ping's marker is absent from the scrollback", () => {
    // Fails CLOSED: if we cannot PROVE the text came after our ping, we do not act on it. A terminal
    // verdict stops retries and makes a billing claim, so an unprovable one must not be reached.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const ep = apiRecoveryEpisode(A) as { attempts: number; lastPingAt: number | undefined };
    Object.assign(ep, { attempts: 1, lastPingAt: T0 + 1_000 });
    noteAgentStatus(A, "working", T0 + 1_100, () => "");
    // A real limit banner, but nothing proving it postdates our ping.
    noteAgentStatus(A, "errored", T0 + 2_000, () => BANNER_SPEND);
    expect(apiRecoveryEpisode(A)?.failure).toBe("retryable");
  });

  it("does not let a SPENT ladder swallow a genuinely new outage", async () => {
    // Scaling the window pushed the tail to an hour, which made this reachable: the ladder is spent and
    // escalated, the outage clears, the agent works for 40 minutes, and an unrelated 529 lands inside
    // that hour. Carried, `attempts` is already 11 → escalate on the first sweep, and the carried
    // `escalated: true` SUPPRESSES the page. Zero rungs, no notification, red until a human happens to
    // look — the mirror of the bug the carry exists to fix, and worse, because it is silent.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const submit = vi.fn(async () => {});
    let clock = T0;
    for (let i = 0; i < REVIVE_LADDER_MS.length; i++) {
      clock += REVIVE_LADDER_MS[i]!;
      await sweepApiRecovery(deps({ now: clock, submit }));
      noteAgentStatus(A, "working", clock + 100, () => "");
      noteAgentStatus(A, "errored", clock + 1_000, () => BANNER_529);
    }
    expect(apiRecoveryEpisode(A)?.attempts).toBe(REVIVE_LADDER_MS.length);

    // The human is told — this is what makes a later swallow SILENT, and so what the collapse keys on.
    const onEscalate = vi.fn();
    await sweepApiRecovery(deps({ now: clock + 2_000, submit, onEscalate }));
    expect(onEscalate).toHaveBeenCalledOnce();
    expect(apiRecoveryEpisode(A)?.escalated).toBe(true);

    // Real work happened, then a NEW failure 45 minutes on — which the un-collapsed window would have
    // absorbed (tail rung × 2 is a full hour), suppressing the page via the carried `escalated: true`.
    noteAgentStatus(A, "working", clock + 3_000, () => "");
    const newFailure = clock + 45 * 60_000;
    expect(REVIVE_LADDER_MS[REVIVE_LADDER_MS.length - 1]! * 2).toBeGreaterThan(newFailure - clock);
    expect(noteAgentStatus(A, "errored", newFailure, () => BANNER_529)).toBe("started");
    expect(apiRecoveryEpisode(A)).toMatchObject({ attempts: 0, escalated: false });

    // And it really does get retried rather than sitting silent.
    const submit2 = vi.fn(async () => {});
    await sweepApiRecovery(deps({ now: newFailure + REVIVE_LADDER_MS[0]!, submit: submit2 }));
    expect(submit2).toHaveBeenCalledOnce();
  });






  // ── RETRYING MUST BE BOUNDED (roborev 55566) ───────────────────────────────────────────────────
  // The restart path had NO terminating bound: 11 pings -> restart -> 11 pings, indefinitely, on
  // exactly the sustained-outage path rung 11 is reached from. Two mechanisms were tried and BOTH
  // failed, which is why the bound now counts pings rather than anything about the episode:
  //   * "page once" is inert in production — liveDeps.onEscalate is a deliberate no-op, because the
  //     row is already red and the notification fires via the status path;
  //   * a per-episode ladder COUNTER only travels through a carry, and a carry lapses once lastPingAt
  //     stops advancing, so a fresh episode restarts the count. Verified: it cycled one ladder later.
  // ── THE BOUND (roborev 55566, reshaped by 55612) ───────────────────────────────────────────────
  // Charged in EXHAUSTED LADDERS, not pings: a ladder that revived the agent cost nothing, and
  // charging for it denied a later unrelated 529 its own ladder while asserting something false about
  // it. `PING_BUDGET` is the arithmetic ceiling for reasoning; `MAX_LADDERS_PER_WINDOW` is the guard.

  /** Drive one complete ladder: every rung pings, our own ping greens it, the outage re-errors it. */
  async function runLadder(
    start: number,
    submit: ReturnType<typeof vi.fn>,
    onEscalate: ReturnType<typeof vi.fn>,
    sentAt: number[],
  ): Promise<number> {
    let clock = start;
    for (let i = 0; i < REVIVE_LADDER_MS.length; i++) {
      clock += REVIVE_LADDER_MS[i]!;
      const before = submit.mock.calls.length;
      await sweepApiRecovery(deps({ now: clock, submit, onEscalate }));
      if (submit.mock.calls.length > before) sentAt.push(clock);
      noteAgentStatus(A, "working", clock + 100, () => "");
      const gap = i === REVIVE_LADDER_MS.length - 1 ? 5 * 60_000 : 1_000;
      noteAgentStatus(A, "errored", clock + gap, () => BANNER_529);
      clock += gap;
    }
    return clock;
  }

  // PINNED BY VALUE, deliberately. Every other assertion here is written in terms of the same
  // constants the guard uses and reads the log the guard itself writes — self-consistent, and so
  // tautological. Raising the multiplier from 2 to 3, a 50% increase in retry pressure on a red agent,
  // passed this whole file. Pinned the way REVIVE_LADDER_MS is: change on purpose, or not at all.
  it("pins the bound's MAGNITUDE, not just its self-consistency", () => {
    expect(MAX_LADDERS_PER_WINDOW).toBe(2);
    expect(PING_BUDGET).toBe(22);
    expect(PING_BUDGET_WINDOW_MS).toBe(4 * 60 * 60_000);
    // Whole ladders is the unit, so the founder's ladder stays the measure of retry pressure.
    expect(PING_BUDGET).toBe(REVIVE_LADDER_MS.length * MAX_LADDERS_PER_WINDOW);
  });

  it("STOPS retrying after MAX_LADDERS_PER_WINDOW exhausted ladders, and says so once", async () => {
    const submit = vi.fn(async () => {});
    const onEscalate = vi.fn();
    const sentAt: number[] = [];
    let clock = T0;
    noteAgentStatus(A, "errored", clock, () => BANNER_529);
    for (let n = 0; n < MAX_LADDERS_PER_WINDOW; n++) clock = await runLadder(clock, submit, onEscalate, sentAt);

    expect(apiRecoveryLadderCount(A, clock)).toBe(MAX_LADDERS_PER_WINDOW);
    expect(submit).toHaveBeenCalledTimes(PING_BUDGET);

    // The next ladder's worth of opportunity buys nothing at all.
    const before = submit.mock.calls.length;
    clock = await runLadder(clock, submit, onEscalate, sentAt);
    expect(submit.mock.calls.length).toBe(before);

    // Told once — not once per episode. Each re-error opens a new episode, and `escalated` lives on
    // the episode, so an episode-scoped latch re-paged for every one of them (roborev 55612).
    const budgetPages = onEscalate.mock.calls.filter((c) => c[1] === BUDGET_SPENT_REASON);
    expect(budgetPages).toHaveLength(1);

    // THE SPEND IS REPORTED, AND IT IS THE REAL ONE (roborev 57773). The 4th argument is what the
    // concierge's give-up report quotes. Reading `episode.attempts` instead would report ZERO here:
    // the budget is charged across PRIOR ladders and checked BEFORE `attempts` is assigned, so the
    // common case is a brand-new episode — and "retried 0 times and stayed dead" attached to a
    // reason saying the agent "has been auto-retried as much as is useful" understates the only
    // evidence anyone gets. Asserting the CALL SITE here is the half a hand-built `liveDeps` test
    // structurally cannot cover: deleting `pinged.length` from the producer left that one green.
    expect(budgetPages[0]![3]).toBeGreaterThan(0);
    expect(budgetPages[0]![3]).toBe(PING_BUDGET);
  });

  it("TERMINATES even when no ladder ever completes — the unconditional ceiling", async () => {
    // The High from roborev 55863. Charging only EXHAUSTED ladders re-introduced the episode-identity
    // dependence the bound exists to remove: `attempts` advances only through a carry, so if every
    // re-error lands OUTSIDE episodeCarryWindowMs (a request that takes three minutes to 529 out is
    // enough), each re-entry opens a fresh episode at rung 0, no ladder ever completes, nothing is
    // charged, and it pings forever at a rung-0 cadence. Every other test in this file re-errors at
    // clock + 1_000 — inside the window — so every ladder completed BY CONSTRUCTION and none of them
    // could see this.
    const submit = vi.fn(async () => {});
    const onEscalate = vi.fn();
    const sent: number[] = [];
    let clock = T0;
    noteAgentStatus(A, "errored", clock, () => BANNER_529);
    // 200 opportunities, each a fresh episode: ping rung 0, go green, re-error well outside the window.
    for (let i = 0; i < 200; i++) {
      clock += REVIVE_LADDER_MS[0]!;
      const before = submit.mock.calls.length;
      await sweepApiRecovery(deps({ now: clock, submit, onEscalate }));
      if (submit.mock.calls.length > before) sent.push(clock);
      noteAgentStatus(A, "working", clock + 100, () => "");
      clock += 5 * 60_000; // > EPISODE_CARRY_MS, so the next entry is a NEW episode at rung 0
      noteAgentStatus(A, "errored", clock, () => BANNER_529);
    }
    // No ladder ever completed, so the ladder counter is blind here...
    expect(apiRecoveryLadderCount(A, clock)).toBe(0);
    // ...and the ceiling is what stops it. This run spans ~16h, so the window rolls several times —
    // the guarantee is per-window, not a lifetime cap (asserting a lifetime total is the mistake this
    // file has now made twice). Unbounded, all 200 opportunities would ping.
    for (const t of sent) {
      const inWindow = sent.filter((u) => u <= t && t - u < PING_BUDGET_WINDOW_MS);
      expect(inWindow.length).toBeLessThanOrEqual(PING_BUDGET);
    }
    expect(sent.length).toBeLessThan(200 / 2);
    expect(onEscalate.mock.calls.some((c) => c[1] === BUDGET_SPENT_REASON)).toBe(true);
  });

  it("pages AGAIN on a second give-up after the window rolls", async () => {
    // The page used to latch on time-since-last-page while the counter pruned from each ladder's own
    // timestamp, so the two windows drifted and the SECOND give-up was silently swallowed (55863).
    const submit = vi.fn(async () => {});
    const onEscalate = vi.fn();
    const sentAt: number[] = [];
    let clock = T0;
    noteAgentStatus(A, "errored", clock, () => BANNER_529);
    for (let n = 0; n < MAX_LADDERS_PER_WINDOW; n++) clock = await runLadder(clock, submit, onEscalate, sentAt);
    // Sweep at a moment a rung is DUE, or the decision is "waiting-for-next-rung" and the ping guard
    // — where the give-up page lives — is never reached.
    await sweepApiRecovery(deps({ now: clock + REVIVE_LADDER_MS[0]!, submit, onEscalate }));
    expect(onEscalate.mock.calls.filter((c) => c[1] === BUDGET_SPENT_REASON)).toHaveLength(1);

    // Window rolls; the agent earns its retries back and spends them again.
    clock += PING_BUDGET_WINDOW_MS + 60_000;
    expect(apiRecoveryLadderCount(A, clock)).toBe(0);
    noteAgentStatus(A, "errored", clock, () => BANNER_529);
    for (let n = 0; n < MAX_LADDERS_PER_WINDOW; n++) clock = await runLadder(clock, submit, onEscalate, sentAt);
    await sweepApiRecovery(deps({ now: clock + REVIVE_LADDER_MS[0]!, submit, onEscalate }));
    // Told a SECOND time — the human must hear about the second give-up too.
    expect(onEscalate.mock.calls.filter((c) => c[1] === BUDGET_SPENT_REASON)).toHaveLength(2);
  });

  it("does NOT charge a ladder that REVIVED the agent against its next outage", async () => {
    // The harm 55612 found: two ladders that each worked still spent the whole allowance, so a third,
    // plainly transient 529 got zero retries plus a page saying it "has been auto-retried as much as
    // is useful and is still failing" — false about that failure. Only a ladder that ran ALL the way
    // out is evidence retrying is not working.
    const submit = vi.fn(async () => {});
    let clock = T0;
    for (let n = 0; n < 2; n++) {
      noteAgentStatus(A, "errored", clock, () => BANNER_529);
      // Part-way up the ladder, the retry WORKS: the agent goes green and stays green.
      for (let i = 0; i < 8; i++) {
        clock += REVIVE_LADDER_MS[i]!;
        await sweepApiRecovery(deps({ now: clock, submit }));
        noteAgentStatus(A, "working", clock + 100, () => "");
        if (i < 7) {
          noteAgentStatus(A, "errored", clock + 1_000, () => BANNER_529);
          clock += 1_000;
        }
      }
      // Longer than the widest carry window, so this is genuinely "recovered, then worked" rather
      // than a resumed episode — otherwise the next failure inherits a rung count and never reaches
      // rung 0, which would be the carry working correctly and not the thing under test.
      clock += 90 * 60_000;
    }
    expect(apiRecoveryLadderCount(A, clock)).toBe(0); // nothing exhausted, nothing charged

    // A NEW outage inside the same window still gets its rung-0 retry.
    const submit2 = vi.fn(async () => {});
    noteAgentStatus(A, "errored", clock, () => BANNER_529);
    await sweepApiRecovery(deps({ now: clock + REVIVE_LADDER_MS[0]!, submit: submit2 }));
    expect(submit2).toHaveBeenCalledOnce();
    expect(submit2).toHaveBeenCalledWith(A, revivePrompt(1));
  });

  it("never exceeds MAX_LADDERS_PER_WINDOW exhausted ladders in any rolling window", async () => {
    // The real invariant, checked on a realistic multi-ladder run and independent of the guard's own
    // bookkeeping. Note it is a LADDER bound, not a ping bound: the window can roll mid-ladder, so
    // pings-per-window is not the thing guaranteed and asserting it was measuring the wrong quantity.
    const submit = vi.fn(async () => {});
    const onEscalate = vi.fn();
    const sentAt: number[] = [];
    const exhaustedAt: number[] = [];
    let clock = T0;
    noteAgentStatus(A, "errored", clock, () => BANNER_529);
    for (let n = 0; n < 6; n++) {
      const before = sentAt.length;
      clock = await runLadder(clock, submit, onEscalate, sentAt);
      // A ladder that emitted every rung is an exhausted one.
      if (sentAt.length - before === REVIVE_LADDER_MS.length) exhaustedAt.push(clock);
      for (const t of exhaustedAt) {
        const inWindow = exhaustedAt.filter((u) => u <= t && t - u < PING_BUDGET_WINDOW_MS);
        expect(inWindow.length).toBeLessThanOrEqual(MAX_LADDERS_PER_WINDOW);
      }
    }
    // And it really did refuse work it was offered — 66 rungs came due, far fewer pings went out.
    expect(sentAt.length).toBeGreaterThan(0);
    expect(sentAt.length).toBeLessThan(REVIVE_LADDER_MS.length * 6);
  });

  it("lets an agent retry again once the window has rolled past its old ladders", async () => {
    // Bounded PRESSURE, not a permanent ban: an outage can outlast the window, and an agent that
    // struggled hours ago should not be refused its first retry.
    const submit = vi.fn(async () => {});
    const onEscalate = vi.fn();
    const sentAt: number[] = [];
    let clock = T0;
    noteAgentStatus(A, "errored", clock, () => BANNER_529);
    for (let n = 0; n < MAX_LADDERS_PER_WINDOW; n++) clock = await runLadder(clock, submit, onEscalate, sentAt);
    expect(apiRecoveryLadderCount(A, clock)).toBe(MAX_LADDERS_PER_WINDOW);

    const later = clock + PING_BUDGET_WINDOW_MS + 60_000;
    expect(apiRecoveryLadderCount(A, later)).toBe(0);
    const submit2 = vi.fn(async () => {});
    noteAgentStatus(A, "errored", later, () => BANNER_529);
    await sweepApiRecovery(deps({ now: later + REVIVE_LADDER_MS[0]!, submit: submit2 }));
    expect(submit2).toHaveBeenCalledOnce();
  });

  it("does not let a closed agent's spent budget be inherited by a reused id", async () => {
    const submit = vi.fn(async () => {});
    const onEscalate = vi.fn();
    const sentAt: number[] = [];
    let clock = T0;
    noteAgentStatus(A, "errored", clock, () => BANNER_529);
    for (let n = 0; n < MAX_LADDERS_PER_WINDOW; n++) clock = await runLadder(clock, submit, onEscalate, sentAt);
    expect(apiRecoveryLadderCount(A, clock)).toBe(MAX_LADDERS_PER_WINDOW);

    forgetAgent(A); // pane closed / project unloaded
    expect(apiRecoveryLadderCount(A, clock)).toBe(0);

    const submit2 = vi.fn(async () => {});
    noteAgentStatus(A, "errored", clock, () => BANNER_529);
    await sweepApiRecovery(deps({ now: clock + REVIVE_LADDER_MS[0]!, submit: submit2 }));
    expect(submit2).toHaveBeenCalledOnce();
  });

  it("sends the rung-0 ping when ping 11 SUCCEEDED and a new outage arrives much later", async () => {
    // The production path the previous gate missed entirely (roborev 55534). `escalated` can never
    // become true on the success path, so the un-escalated hour-wide window carried a 45-minute-later
    // failure at `attempts: 11` → escalate at once with a false claim, ZERO retries for a plainly
    // transient 529. The coverage had moved too: the sibling test forces `escalated: true` first, so
    // nothing exercised this branch.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const submit = vi.fn(async () => {});
    let clock = T0;
    for (let i = 0; i < REVIVE_LADDER_MS.length; i++) {
      clock += REVIVE_LADDER_MS[i]!;
      await sweepApiRecovery(deps({ now: clock, submit }));
      noteAgentStatus(A, "working", clock + 100, () => "");
      if (i < REVIVE_LADDER_MS.length - 1) noteAgentStatus(A, "errored", clock + 1_000, () => BANNER_529);
    }
    // Ping 11 WORKED — the agent is green and stays green. Nothing ever saw attempts >= length errored.
    expect(apiRecoveryEpisode(A)).toBeUndefined();

    // 45 minutes of real work later, an unrelated 529. Inside the un-escalated window (tail × 2 = 1h).
    const newFailure = clock + 45 * 60_000;
    expect(newFailure - clock).toBeLessThan(REVIVE_LADDER_MS[REVIVE_LADDER_MS.length - 1]! * 2);
    noteAgentStatus(A, "errored", newFailure, () => BANNER_529);

    const submit2 = vi.fn(async () => {});
    const onEscalate = vi.fn();
    await sweepApiRecovery(deps({ now: newFailure + REVIVE_LADDER_MS[0]!, submit: submit2, onEscalate }));
    expect(submit2).toHaveBeenCalledOnce();
    expect(submit2).toHaveBeenCalledWith(A, revivePrompt(1));
    // Crucially it is NOT given the false "outage is outlasting the ladder" give-up.
    expect(onEscalate.mock.calls.map((c) => String(c[1])).join(" ")).not.toMatch(
      /outlasting the ladder/,
    );
  });

  it("STILL carries at exhaustion when the re-fail is immediate, so escalation survives", async () => {
    // The counterpart, and the reason exhaustion is bounded by TIME rather than refused outright:
    // ping 11 clears `errored` itself, so the re-entry is the ONLY path on which `attempts >= length`
    // is ever evaluated. Refusing the carry there restarts the ladder at rung 0 forever and the human
    // is never told — a mistake made and caught by this test's sibling below.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const submit = vi.fn(async () => {});
    let clock = T0;
    for (let i = 0; i < REVIVE_LADDER_MS.length; i++) {
      clock += REVIVE_LADDER_MS[i]!;
      await sweepApiRecovery(deps({ now: clock, submit }));
      noteAgentStatus(A, "working", clock + 100, () => "");
      // Seconds, not minutes — the outage never ended.
      expect(noteAgentStatus(A, "errored", clock + 1_000, () => BANNER_529)).toBe("resumed");
    }
    expect(apiRecoveryEpisode(A)?.attempts).toBe(REVIVE_LADDER_MS.length);
    const onEscalate = vi.fn();
    await sweepApiRecovery(deps({ now: clock + 60 * 60_000, submit, onEscalate }));
    expect(onEscalate).toHaveBeenCalledOnce();
  });

  it("UPGRADES a carried episode to terminal when the new banner is an account limit", async () => {
    // `failure` was inherited on elapsed time alone, so a real limit banner arriving mid-ladder kept
    // the `retryable` verdict and the human was told "the outage is outlasting the ladder" instead of
    // "blocked on an ACCOUNT limit" — a wrong REASON on top of the wasted pings.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const submit = vi.fn(async () => {});
    const clock = T0 + REVIVE_LADDER_MS[0]!;
    await sweepApiRecovery(deps({ now: clock, submit }));
    expect(apiRecoveryEpisode(A)?.failure).toBe("retryable");

    // Our ping greens it; the retry then dies on a spend cap instead of another 529. The scrollback
    // must carry our prompt, since the re-scan only judges what provably arrived AFTER it.
    noteAgentStatus(A, "working", clock + 100, () => "");
    const afterPing = [revivePrompt(1), BANNER_SPEND].join("\n");
    expect(noteAgentStatus(A, "errored", clock + 1_000, () => afterPing)).toBe("resumed");
    expect(apiRecoveryEpisode(A)).toMatchObject({ failure: "terminal", attempts: 1 });

    // So the escalation says the right thing, and no further prompt is sent at a wall.
    const onEscalate = vi.fn();
    const submit2 = vi.fn(async () => {});
    await sweepApiRecovery(deps({ now: clock + 2_000, submit: submit2, onEscalate }));
    expect(submit2).not.toHaveBeenCalled();
    expect(onEscalate).toHaveBeenCalledOnce();
    expect(onEscalate.mock.calls[0]![1]).toMatch(/account|limit/i);
  });

  // THE SAFETY PROPERTY THE CARRY RE-SCAN RESTS ON. By the time a carry re-reads the scrollback, our
  // own retry prompt is in it — and that prompt talks about BOTH "529 Overloaded" and "an account
  // limit". The re-scan is safe only because `terminal` demands the line-initial "You've hit your …
  // limit" opener AND a "· resets"/"raise it at" tail, which the prompt never carries. So it is the
  // WORDING of revivePrompt that keeps a carry from escalating on its own echo — reword it into that
  // shape and every retried agent would be falsely reported as out of quota. This test guards that.
  it("cannot manufacture a TERMINAL verdict out of our own retry prompt", () => {
    for (let n = 1; n <= REVIVE_LADDER_MS.length; n++) {
      // The marker the post-ping slice keys on must actually be IN the prompt, or the re-scan silently
      // degrades to "never upgrade" — a quiet loss, not a loud one.
      expect(revivePrompt(n)).toContain(REVIVE_PROMPT_MARKER);
      expect(classifyFromScrollback(revivePrompt(n))).not.toBe("terminal");
    }
    // And end-to-end: a carry whose only new scrollback is our echo keeps the verdict it had.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const ep = apiRecoveryEpisode(A) as { attempts: number; lastPingAt: number | undefined };
    Object.assign(ep, { attempts: 1, lastPingAt: T0 + 1_000 });
    noteAgentStatus(A, "working", T0 + 1_100, () => "");
    expect(noteAgentStatus(A, "errored", T0 + 2_000, () => revivePrompt(1))).toBe("resumed");
    expect(apiRecoveryEpisode(A)?.failure).toBe("retryable");
  });

  it("does not remember an episode that never got a ping — it could never carry", () => {
    // The carry test keys on `lastPingAt`, so an un-pinged episode is dead weight by construction.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    noteAgentStatus(A, "working", T0 + 100, () => ""); // recovered on its own; we never typed
    expect(__apiRecoveryCarrySize()).toBe(0);
  });

  it("prunes carry memory older than any window could accept", async () => {
    // An entry was only ever removed by a re-entry into `errored`, `forgetAgent`, or a reset — so an
    // agent that hiccuped once and then behaved left its entry behind forever. Over a long orchestrator
    // session that is one dead entry per worker uuid that ever failed.
    const submit = vi.fn(async () => {});
    noteAgentStatus("stale", "errored", T0, () => BANNER_529);
    await sweepApiRecovery(deps({ now: T0 + REVIVE_LADDER_MS[0]!, submit }));
    noteAgentStatus("stale", "working", T0 + 10_000, () => "");
    expect(__apiRecoveryCarrySize()).toBe(1);

    // A different agent ending its episode two hours later sweeps the dead one out.
    const late = T0 + 2 * 60 * 60_000;
    noteAgentStatus(A, "errored", late, () => BANNER_529);
    await sweepApiRecovery(deps({ now: late + REVIVE_LADDER_MS[0]!, submit }));
    noteAgentStatus(A, "working", late + 10_000, () => "");
    expect(__apiRecoveryCarrySize()).toBe(1); // A's entry only — "stale" is gone
  });

  it("does not prune an entry a DEEP-rung carry could still accept", () => {
    // The prune bound must be the MAX over every rung, not `episodeCarryWindowMs(length)` — that
    // function is not monotonic (it collapses to the floor at exhaustion), so indexing the last rung
    // yields the SMALLEST window and would evict entries a live carry still wants. A rung-10 episode
    // has a 40-minute window; an unrelated agent's episode ending 30 minutes later must not kill it.
    const deep = REVIVE_LADDER_MS.length - 1;
    const window = episodeCarryWindowMs(deep);
    expect(window).toBeGreaterThan(30 * 60_000);

    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const ep = apiRecoveryEpisode(A) as { attempts: number; lastPingAt: number | undefined };
    Object.assign(ep, { attempts: deep, lastPingAt: T0 });
    noteAgentStatus(A, "working", T0 + 100, () => ""); // our ping greened it; entry remembered

    // Another agent's episode ends 30 minutes on, which is when the prune runs.
    const later = T0 + 30 * 60_000;
    noteAgentStatus("other", "errored", later - 1_000, () => BANNER_529);
    const other = apiRecoveryEpisode("other") as { attempts: number; lastPingAt: number | undefined };
    Object.assign(other, { attempts: 1, lastPingAt: later - 500 });
    noteAgentStatus("other", "working", later, () => "");

    // A's rung must have survived that prune.
    expect(noteAgentStatus(A, "errored", later, () => BANNER_529)).toBe("resumed");
    expect(apiRecoveryEpisode(A)?.attempts).toBe(deep);
  });

  it("does not carry a rung count across an agent that went away", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    await sweepApiRecovery(deps());
    noteAgentStatus(A, "working", T0 + 6_000, () => "");
    forgetAgent(A); // pane closed / project unloaded
    noteAgentStatus(A, "errored", T0 + 7_000, () => BANNER_529);
    expect(apiRecoveryEpisode(A)).toMatchObject({ attempts: 0 });
  });

  // ── FAIL-CLOSED HOLES IN THE SWEEP LOOP (roborev 55433, Medium) ───────────────────────────────
  it("refuses when the agent has NO status entry, rather than assuming it still failed", async () => {
    // runtimeStore.resetProgress deletes the status key while the pane stays mounted for a fresh run
    // in the reused slot — and there canAcceptInput and processAlive both still pass. Defaulting to
    // `errored` pasted "automatic retry 1 of 11" into an agent that just started a new session.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const d = deps({ statusOf: () => undefined });
    const out = await sweepApiRecovery(d);
    expect(out).toEqual([{ agentId: A, decision: { action: "none", reason: "status-unknown" } }]);
    expect(d.submit).not.toHaveBeenCalled();
  });

  it("does not ping an agent whose episode closed while an earlier agent's write was in flight", async () => {
    // An outage errors several agents at once; the loop awaits two PTY writes plus a CR delay per
    // agent, so B can recover while A is still being written to. Holding B's episode object from the
    // snapshot would paste a retry into an agent that has already recovered.
    noteAgentStatus("a", "errored", T0, () => BANNER_529);
    noteAgentStatus("b", "errored", T0, () => BANNER_529);
    const submit = vi.fn(async (id: string) => {
      if (id === "a") noteAgentStatus("b", "working", T0 + 1, () => ""); // b recovers mid-sweep
    });
    await sweepApiRecovery(deps({ submit }));
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith("a", expect.any(String));
  });

  // A failed write must not leave the rung un-consumed, or a dead PTY becomes a tight loop on every
  // sweep — the unbounded-retry failure the ladder's bounds exist to prevent.
  it("consumes the rung even when the write fails, so a dead PTY can't spin", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const submit = vi.fn(async () => {
      throw new Error("no such pty");
    });
    await sweepApiRecovery(deps({ submit }));
    expect(apiRecoveryEpisode(A)).toMatchObject({ attempts: 1 });

    // The very next sweep, at the same instant, must not fire again.
    await sweepApiRecovery(deps({ submit }));
    expect(submit).toHaveBeenCalledOnce();
  });

  it("refuses when the agent cannot take input or its process is gone", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const unreachable = deps({ canAcceptInput: () => false });
    await sweepApiRecovery(unreachable);
    expect(unreachable.submit).not.toHaveBeenCalled();

    const dead = deps({ processAliveOf: () => false });
    await sweepApiRecovery(dead);
    expect(dead.submit).not.toHaveBeenCalled();
  });

  // processAliveOf returning undefined means "nobody looked", which must produce the honest
  // liveness-unknown refusal rather than the false "its process is gone".
  it("distinguishes an unprobed process from a dead one", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const out = await sweepApiRecovery(deps({ processAliveOf: () => undefined }));
    expect(out[0]!.decision).toEqual({ action: "none", reason: "liveness-unknown" });

    __resetApiRecovery();
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const dead = await sweepApiRecovery(deps({ processAliveOf: () => false }));
    expect(dead[0]!.decision).toEqual({ action: "none", reason: "process-gone" });
  });

  it("does nothing at all when no agent is in an episode", async () => {
    const d = deps();
    expect(await sweepApiRecovery(d)).toEqual([]);
    expect(d.submit).not.toHaveBeenCalled();
  });

  it("stops pinging an agent that recovered mid-episode", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    noteAgentStatus(A, "working", T0 + 1_000, () => "");
    const d = deps();
    expect(await sweepApiRecovery(d)).toEqual([]);
    expect(d.submit).not.toHaveBeenCalled();
  });
});

describe("nextRetryDueAt", () => {
  it("reports the soonest pending rung across episodes", () => {
    noteAgentStatus("a", "errored", T0, () => BANNER_529);
    noteAgentStatus("b", "errored", T0 - 3_000, () => BANNER_529);
    // b entered errored earlier, so its 5s rung comes due first.
    expect(nextRetryDueAt(T0)).toBe(T0 - 3_000 + REVIVE_LADDER_MS[0]!);
  });

  it("is null when nothing is pending", () => {
    expect(nextRetryDueAt(T0)).toBeNull();
  });
});

describe("episodeCarryWindowMs", () => {
  it("exceeds every PENDING rung it guards, and never dips below the floor", () => {
    // The property the fixed constant violated: a window shorter than the wait that preceded the ping
    // cannot cover "we waited that long, typed, and it failed again". Holds for every rung that still
    // has a successor — exhaustion is deliberately different, next test.
    expect(episodeCarryWindowMs(0)).toBe(EPISODE_CARRY_MS);
    for (let a = 1; a < REVIVE_LADDER_MS.length; a++) {
      expect(episodeCarryWindowMs(a)).toBeGreaterThanOrEqual(EPISODE_CARRY_MS);
      expect(episodeCarryWindowMs(a)).toBeGreaterThan(REVIVE_LADDER_MS[a - 1]!);
    }
  });

  it("grows with the ladder instead of staying flat", () => {
    // The asymmetry 55457 found: rungs reach 30 minutes, so a 2-minute window made a carry LESS likely
    // the deeper the episode got — exactly backwards.
    const deepestPending = episodeCarryWindowMs(REVIVE_LADDER_MS.length - 1);
    expect(deepestPending).toBeGreaterThan(EPISODE_CARRY_MS);
    expect(deepestPending).toBeGreaterThan(episodeCarryWindowMs(1));
  });

  it("collapses to the floor when the ladder is SPENT or the episode already ESCALATED", () => {
    // Both are cases where a WIDE window would let an old, finished episode absorb a later unrelated
    // failure — inheriting a spent rung count (zero retries for a new 529) or a set `escalated` (the
    // page suppressed, red in silence). The wide window only has a job while rungs remain.
    const spent = REVIVE_LADDER_MS.length;
    expect(episodeCarryWindowMs(spent, false)).toBe(EPISODE_CARRY_MS);
    expect(episodeCarryWindowMs(spent + 5, false)).toBe(EPISODE_CARRY_MS);
    for (let a = 1; a <= spent; a++) {
      expect(episodeCarryWindowMs(a, true)).toBe(EPISODE_CARRY_MS);
    }
    // ...and stays wide for every rung that still has a successor, which is what 55457 was about.
    expect(episodeCarryWindowMs(spent - 1, false)).toBeGreaterThan(EPISODE_CARRY_MS);
  });

  it("clamps past the end of the ladder rather than reading off it", () => {
    expect(episodeCarryWindowMs(REVIVE_LADDER_MS.length + 5)).toBe(
      episodeCarryWindowMs(REVIVE_LADDER_MS.length),
    );
    expect(Number.isFinite(episodeCarryWindowMs(1_000))).toBe(true);
  });
});
