import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EPISODE_CARRY_MS,
  __apiRecoveryCarrySize,
  __resetApiRecovery,
  apiRecoveryEpisode,
  episodeCarryWindowMs,
  forgetAgent,
  apiRecoveryPingCount,
  PING_BUDGET_WINDOW_MS,
  PING_BUDGET,
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
    hasExited: () => false, // alive
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
  it("bounds retry pings to PING_BUDGET inside the rolling window", async () => {
    const submit = vi.fn(async () => {});
    let clock = T0;
    noteAgentStatus(A, "errored", clock, () => BANNER_529);
    // Drive far more ladders than the budget allows, asserting the invariant CONTINUOUSLY. Checking
    // only the total at the end cannot express this: the window legitimately rolls during a multi-hour
    // run, so the bound is "never more than PING_BUDGET within any window", not a lifetime cap.
    for (let ladder = 0; ladder < 6; ladder++) {
      for (let i = 0; i < REVIVE_LADDER_MS.length; i++) {
        clock += REVIVE_LADDER_MS[i]!;
        await sweepApiRecovery(deps({ now: clock, submit }));
        expect(apiRecoveryPingCount(A, clock)).toBeLessThanOrEqual(PING_BUDGET);
        noteAgentStatus(A, "working", clock + 100, () => "");
        const gap = i === REVIVE_LADDER_MS.length - 1 ? 5 * 60_000 : 1_000;
        noteAgentStatus(A, "errored", clock + gap, () => BANNER_529);
        clock += gap;
      }
    }
    // Six ladders' worth of opportunity (66 rungs) produced at most two ladders' worth of pings per
    // window — the unbounded version sent all 66.
    expect(submit.mock.calls.length).toBeLessThan(REVIVE_LADDER_MS.length * 6);
    expect(apiRecoveryPingCount(A, clock)).toBeLessThanOrEqual(PING_BUDGET);
  });

  it("STOPS pinging once the budget is spent, and says so once", async () => {
    const submit = vi.fn(async () => {});
    const onEscalate = vi.fn();
    // Spend the budget outright, then assert nothing more is sent however many sweeps run.
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const ep = apiRecoveryEpisode(A) as { attempts: number; lastPingAt: number | undefined };
    for (let n = 0; n < PING_BUDGET; n++) {
      Object.assign(ep, { attempts: 0, lastPingAt: undefined });
      await sweepApiRecovery(deps({ now: T0 + REVIVE_LADDER_MS[0]! + n, submit, onEscalate }));
    }
    expect(submit).toHaveBeenCalledTimes(PING_BUDGET);
    expect(apiRecoveryPingCount(A, T0 + 60_000)).toBe(PING_BUDGET);

    const spent = submit.mock.calls.length;
    for (const t of [1, 5, 30, 60]) {
      Object.assign(ep, { attempts: 0, lastPingAt: undefined });
      await sweepApiRecovery(deps({ now: T0 + t * 60_000, submit, onEscalate }));
    }
    expect(submit.mock.calls.length).toBe(spent);
    expect(onEscalate).toHaveBeenCalledOnce();
    expect(onEscalate.mock.calls[0]![1]).toBe(BUDGET_SPENT_REASON);
  });

  it("lets an agent retry again once the window has rolled past its old pings", async () => {
    // Bounded PRESSURE, not a permanent ban: an outage can outlast the window, and an agent that had
    // trouble hours ago should not be refused its first retry.
    const submit = vi.fn(async () => {});
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const ep = apiRecoveryEpisode(A) as { attempts: number; lastPingAt: number | undefined };
    for (let n = 0; n < PING_BUDGET; n++) {
      Object.assign(ep, { attempts: 0, lastPingAt: undefined });
      await sweepApiRecovery(deps({ now: T0 + REVIVE_LADDER_MS[0]! + n, submit }));
    }
    expect(submit).toHaveBeenCalledTimes(PING_BUDGET);

    const later = T0 + PING_BUDGET_WINDOW_MS + 60_000;
    expect(apiRecoveryPingCount(A, later)).toBe(0);
    Object.assign(ep, { attempts: 0, lastPingAt: undefined, escalated: false });
    await sweepApiRecovery(deps({ now: later, submit }));
    expect(submit).toHaveBeenCalledTimes(PING_BUDGET + 1);
  });

  it("does not let a closed agent's spent budget be inherited by a reused id", async () => {
    const submit = vi.fn(async () => {});
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const ep = apiRecoveryEpisode(A) as { attempts: number; lastPingAt: number | undefined };
    for (let n = 0; n < PING_BUDGET; n++) {
      Object.assign(ep, { attempts: 0, lastPingAt: undefined });
      await sweepApiRecovery(deps({ now: T0 + REVIVE_LADDER_MS[0]! + n, submit }));
    }
    forgetAgent(A); // pane closed / project unloaded
    expect(apiRecoveryPingCount(A, T0 + 60_000)).toBe(0);

    noteAgentStatus(A, "errored", T0 + 60_000, () => BANNER_529);
    await sweepApiRecovery(deps({ now: T0 + 60_000 + REVIVE_LADDER_MS[0]!, submit }));
    expect(submit).toHaveBeenCalledTimes(PING_BUDGET + 1);
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

    const dead = deps({ hasExited: () => true });
    await sweepApiRecovery(dead);
    expect(dead.submit).not.toHaveBeenCalled();
  });

  // hasExited returning undefined means "nobody looked", which must produce the honest
  // liveness-unknown refusal rather than the false "its process is gone".
  it("distinguishes an unprobed process from a dead one", async () => {
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const out = await sweepApiRecovery(deps({ hasExited: () => undefined }));
    expect(out[0]!.decision).toEqual({ action: "none", reason: "liveness-unknown" });

    __resetApiRecovery();
    noteAgentStatus(A, "errored", T0, () => BANNER_529);
    const dead = await sweepApiRecovery(deps({ hasExited: () => true }));
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
