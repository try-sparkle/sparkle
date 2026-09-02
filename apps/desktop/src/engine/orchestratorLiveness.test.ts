import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_SILENT_MS,
  epicOrchestratorLiveness,
  epicRestartRemedy,
  orchestratorLivenessOf,
  restartRemedyFor,
} from "./orchestratorLiveness";
import type { DeathCause } from "./deathTypes";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("orchestratorLivenessOf", () => {
  // ══ THE MEASURED FAILURE, AS ONE TEST ═══════════════════════════════════════════════════════
  // 25 epics `in_progress`, 17 with a named orchestrator, every one of them idle with an activity
  // timestamp 93-121 HOURS old, and the sweep answering `orchestrator-alive` on every tick for five
  // days. `processAliveFor` returns `undefined` for an orchestrator whose pane this window is not
  // hosting, and the old expression — `bound.some((a) => alive(a.id) !== false)` — read that as
  // ALIVE. This is the assertion that fails without the fix.
  it("an orchestrator this window never observed, silent for 121 hours, is NOT staffing", () => {
    expect(
      orchestratorLivenessOf(
        { observedAlive: undefined, lastHookEventMs: NOW - 121 * HOUR },
        NOW,
      ),
    ).toBe(false);
  });

  // The other half of the same incident: the pane IS mounted, the status map says `idle` — a LATCH
  // written days ago that nothing can retract — and the hook log proves nothing has run since. The
  // measurement must beat the latch, or an epic whose orchestrator died with its pane open stays
  // "staffed" forever exactly as the unobserved one did.
  it("a hook log older than the window beats an OBSERVED-ALIVE status", () => {
    expect(
      orchestratorLivenessOf({ observedAlive: true, lastHookEventMs: NOW - 93 * HOUR }, NOW),
    ).toBe(false);
  });

  it("a hook event inside the window is staffing, whatever the status says", () => {
    expect(
      orchestratorLivenessOf({ observedAlive: undefined, lastHookEventMs: NOW - 60_000 }, NOW),
    ).toBe(true);
  });

  // A single long tool call — a cold `cargo test`, a `pnpm verify` run — emits no `PostToolUse`
  // until it completes. The window has to outlast that or the sweep invents deaths for agents that
  // are working. Exactly at the boundary counts as alive: the comparison is `<=`, so a reading
  // stamped precisely `silentMs` ago is not yet evidence of silence.
  it("is generous: a 55-minute-long single tool call still reads as staffing", () => {
    expect(
      orchestratorLivenessOf({ observedAlive: true, lastHookEventMs: NOW - 55 * 60_000 }, NOW),
    ).toBe(true);
    expect(
      orchestratorLivenessOf(
        { observedAlive: undefined, lastHookEventMs: NOW - ORCHESTRATOR_SILENT_MS },
        NOW,
      ),
    ).toBe(true);
    expect(
      orchestratorLivenessOf(
        { observedAlive: undefined, lastHookEventMs: NOW - ORCHESTRATOR_SILENT_MS - 1 },
        NOW,
      ),
    ).toBe(false);
  });

  // ══ A PERSON IS THE BLOCKER, SO THE SILENCE IS THE WAIT (roborev 72648, High) ══════════════
  // `processAliveFor`'s DEAD set is only done|errored|stopped, so every one of these reports ALIVE —
  // and a hook log freezes at exactly these statuses, because a `PreToolUse` for a blocking tool
  // with nothing after it IS the unanswered prompt. Reading that as a death makes the sweep hand the
  // epic back, and `sendToBuild` on an already-live orchestrator writes the handoff text into the
  // open prompt: a bracketed paste plus Enter, ANSWERING a permission question the human never saw.
  it.each(["questions", "waiting", "approval", "blocked"] as const)(
    "an agent sitting at a prompt (%s), CORROBORATED by the grid, is STAFFING however old its hook log",
    (status) => {
      expect(
        orchestratorLivenessOf(
          {
            observedAlive: true,
            observedStatus: status,
            observedAttention: "awaiting",
            lastHookEventMs: NOW - 121 * HOUR,
          },
          NOW,
        ),
      ).toBe(true);
    },
  );

  // ══ THE EXEMPTION MUST EXPIRE (roborev 73028, High) ═══════════════════════════════════════
  // `runtimeStore.status` is the SAME non-retractable latch this module distrusts: only a mounted
  // pane writes it and only `close()` clears it, so an orchestrator that hit a prompt and then died
  // in the ENOTFOUND batch kill reads `waiting` for the window's life. Membership alone would make
  // the silence rule unreachable for these four statuses — re-opening the original incident for
  // exactly the rows the bead named, which were "idle/errored/WAITING".
  it.each(["questions", "waiting", "approval", "blocked"] as const)(
    "a latched %s with NO grid reading is not immortal — it is staffing-UNKNOWN, not staffed",
    (status) => {
      expect(
        orchestratorLivenessOf(
          {
            observedAlive: true,
            observedStatus: status,
            observedAttention: undefined,
            lastHookEventMs: NOW - 121 * HOUR,
          },
          NOW,
        ),
      ).toBe(null);
    },
  );

  // `unreadable` holds NO OPINION by its own contract — "it never lowers and never raises" — so it
  // must read exactly like an absent entry, never as corroboration.
  it("an unreadable grid does not corroborate a latched wait", () => {
    expect(
      orchestratorLivenessOf(
        {
          observedAlive: true,
          observedStatus: "waiting",
          observedAttention: "unreadable",
          lastHookEventMs: NOW - 121 * HOUR,
        },
        NOW,
      ),
    ).toBe(null);
  });

  // ══ `calm` MUST NOT AUTHORIZE A RESTART (adversarial review of d9de06a04) ══════════════════
  // An earlier cut let `calm`/`delegating` fall through to the silence rule, reasoning that the grid
  // had seen no prompt. `observed_attention.rs` maps `Refusal::AwaitingInput` to `Verdict::Calm`
  // whenever `screen_awaits_input` fails to re-confirm — and `nudge_gate::write_refusal` has ALREADY
  // failed that predicate before it can return `AwaitingInput`, so every prompt found only by its
  // live-region arm is `Calm` BY CONSTRUCTION. Treating it as "no prompt" re-opened the paste
  // hazard through the very witness added to close it.
  it.each(["calm", "delegating"] as const)(
    "a grid reading of %s is NOT permission to act on a latched wait",
    (verdict) => {
      expect(
        orchestratorLivenessOf(
          {
            observedAlive: true,
            observedStatus: "waiting",
            observedAttention: verdict,
            lastHookEventMs: NOW - 121 * HOUR,
          },
          NOW,
        ),
      ).toBe(null);
    },
  );

  // ══ A GRID PROMPT OUTRANKS THE LATCH, INCLUDING ITS ABSENCE ════════════════════════════════
  // The `awaiting` witness used to be read only INSIDE the WAITING_ON_HUMAN branch, so the module
  // asked the UNTRUSTED latch for permission to consult the TRUSTED one. Any status outside that set
  // — `idle`, `working`, or NO entry at all, which is the common case after a fleet-wide death —
  // skipped it, fell through to the silence rule, and restarted an agent the grid was reporting at a
  // prompt right then.
  it.each([
    ["idle", true as boolean | undefined],
    ["working", true as boolean | undefined],
    [undefined, undefined as boolean | undefined],
  ] as const)(
    "a grid reporting a prompt is staffing even when the latch says %s",
    (status, alive) => {
      expect(
        orchestratorLivenessOf(
          {
            observedAlive: alive,
            ...(status === undefined ? {} : { observedStatus: status }),
            observedAttention: "awaiting",
            lastHookEventMs: NOW - 121 * HOUR,
          },
          NOW,
        ),
      ).toBe(true);
    },
  );

  // PAIRED — without this the hoist could be "any grid reading means staffing". Only `awaiting`
  // outranks the silence rule; a `calm` reading over an `idle` latch still restarts, which is the
  // measured incident and must keep working.
  it("…but a non-prompt grid reading over an idle latch still reaches the silence rule", () => {
    expect(
      orchestratorLivenessOf(
        {
          observedAlive: true,
          observedStatus: "idle",
          observedAttention: "calm",
          lastHookEventMs: NOW - 121 * HOUR,
        },
        NOW,
      ),
    ).toBe(false);
  });

  // ══ A LIVE GRID READING OUTRANKS A DEATH RECORD ════════════════════════════════════════════
  // The nudger emits a verdict only for a PTY in its live set and sweeps everything else to `gone`,
  // which clears the entry — so ANY non-`gone` reading is evidence the process was alive at that
  // reading. A death record beside one is stale, and stale in a KNOWN direction:
  // `deathRecordWriter.openDeathRecord` deliberately does not clear the record when its ledger write
  // fails, a fail-toward-dead default chosen for a row colour. Without this, a respawned orchestrator
  // whose `agent_life_open` was rejected would be restarted — and pasted into — on a `calm` misread
  // of its own open prompt.
  it.each(["calm", "delegating", "unreadable"] as const)(
    "a live grid reading of %s makes a death record untrustworthy",
    (verdict) => {
      expect(
        orchestratorLivenessOf(
          {
            observedAlive: true,
            observedStatus: "waiting",
            observedAttention: verdict,
            deathRecorded: true,
            lastHookEventMs: NOW - 121 * HOUR,
          },
          NOW,
        ),
      ).toBe(null);
    },
  );

  // ══ THE ARM THAT ACTUALLY RECOVERS THE BATCH-KILL POPULATION ═══════════════════════════════
  // The durable ledger is the one POSITIVE statement that the session ended — and a dead PTY has no
  // prompt to type into, which is what makes acting safe. Note this is the ONLY way a latched wait
  // reaches `false`: the deleted `calm` arm could never have done it, because a dead PTY is swept by
  // the nudger, which emits `gone`, which clears the entry to `undefined`.
  it("a durable death record releases a latched wait", () => {
    expect(
      orchestratorLivenessOf(
        {
          observedAlive: true,
          observedStatus: "waiting",
          observedAttention: undefined,
          deathRecorded: true,
          lastHookEventMs: NOW - 121 * HOUR,
        },
        NOW,
      ),
    ).toBe(false);
  });

  // PAIRED: a live prompt outranks a death record, so a stale record cannot re-open the hazard.
  it("…but a grid that still SEES the prompt outranks a death record", () => {
    expect(
      orchestratorLivenessOf(
        {
          observedAlive: true,
          observedStatus: "waiting",
          observedAttention: "awaiting",
          deathRecorded: true,
          lastHookEventMs: NOW - 121 * HOUR,
        },
        NOW,
      ),
    ).toBe(true);
  });

  // `gone` is a value the type admits through the seam even though the listener consumes it by
  // clearing the entry. It must read exactly like an ABSENCE — which now means something the
  // parent's version of this rule did not: absence is the ONLY state in which a death record is
  // honoured, so `gone` must fall through to the death arm rather than be treated as a live reading.
  // (The earlier form of this case asserted `null` for a bare `gone`, which was already true before
  // the two-witness rule existed and so proved nothing.)
  it("a `gone` verdict reads as ABSENCE, so the death record is still honoured", () => {
    expect(
      orchestratorLivenessOf(
        {
          observedAlive: true,
          observedStatus: "waiting",
          observedAttention: "gone",
          deathRecorded: true,
          lastHookEventMs: NOW - 121 * HOUR,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("…and a bare `gone` with no death record is still not corroboration", () => {
    expect(
      orchestratorLivenessOf(
        {
          observedAlive: true,
          observedStatus: "waiting",
          observedAttention: "gone",
          lastHookEventMs: NOW - 121 * HOUR,
        },
        NOW,
      ),
    ).toBe(null);
  });

  // THE PAIRED CASE, and without it the exemption above could be a blanket "observed means alive".
  // `idle` is NOT a human wait, and it is one of the three statuses the bead actually recorded
  // ("idle/errored/waiting"), so the silence rule must still fire on it with a status supplied.
  // An earlier version of this comment said all 17 measured orchestrators read `idle`; they did
  // not, and that overstatement is what made the uncorroborated exemption above look harmless.
  it("…but an IDLE agent with the same stale log is still not staffing", () => {
    expect(
      orchestratorLivenessOf(
        { observedAlive: true, observedStatus: "idle", lastHookEventMs: NOW - 121 * HOUR },
        NOW,
      ),
    ).toBe(false);
    expect(
      orchestratorLivenessOf(
        { observedAlive: true, observedStatus: "working", lastHookEventMs: NOW - 121 * HOUR },
        NOW,
      ),
    ).toBe(false);
  });

  // The exemption is keyed on an OBSERVED status. With none — the measured case, an orchestrator
  // whose pane nobody is hosting — the silence rule applies unmodified and must keep working.
  it("with no observed status the silence rule is unchanged", () => {
    expect(
      orchestratorLivenessOf(
        { observedAlive: undefined, observedStatus: undefined, lastHookEventMs: NOW - 121 * HOUR },
        NOW,
      ),
    ).toBe(false);
  });

  it("an observed death is false even when the hook log is fresh", () => {
    expect(
      orchestratorLivenessOf({ observedAlive: false, lastHookEventMs: NOW - 1000 }, NOW),
    ).toBe(false);
  });

  // No artifact reading and no observation is the honest `null`, which `decideEpicSweep` already
  // skips as `staffing-unknown` and already refuses to CLEAR an escalation on. Today this answers
  // `true` and holds the epic dead forever; naming it is the whole fix.
  it("no witness at all is null, never a silent all-clear", () => {
    expect(orchestratorLivenessOf({ observedAlive: undefined, lastHookEventMs: null }, NOW)).toBe(
      null,
    );
    expect(
      orchestratorLivenessOf({ observedAlive: undefined, lastHookEventMs: undefined }, NOW),
    ).toBe(null);
  });

  it("a mounted, observed agent with no digest reading keeps today's answer", () => {
    expect(orchestratorLivenessOf({ observedAlive: true, lastHookEventMs: null }, NOW)).toBe(true);
  });

  // Clock skew between the hook emitter's wall clock and ours is real. A future stamp read as "just
  // now" would mask a dead orchestrator permanently — the exact failure this module exists to end —
  // so it is treated as NO READING and falls through to the observation, which here is absent.
  it("a FUTURE hook stamp is no reading, not 'just now'", () => {
    expect(
      orchestratorLivenessOf({ observedAlive: undefined, lastHookEventMs: NOW + 60_000 }, NOW),
    ).toBe(null);
    expect(orchestratorLivenessOf({ observedAlive: undefined, lastHookEventMs: 0 }, NOW)).toBe(null);
  });
});

describe("epicOrchestratorLiveness", () => {
  it("one live orchestrator staffs the epic even beside dead tabs", () => {
    expect(epicOrchestratorLiveness([false, null, true])).toBe(true);
  });

  it("an unreadable agent blocks the unstaffed claim", () => {
    expect(epicOrchestratorLiveness([false, null])).toBe(null);
  });

  it("every bound agent silent means unstaffed", () => {
    expect(epicOrchestratorLiveness([false, false])).toBe(false);
  });

  // A roster WAS read and nothing is bound: the genuinely unstaffed epic the sweep was built for.
  // (An unread roster never reaches here — the runner passes `null` directly for that.)
  it("nothing bound, on a roster we read, is unstaffed", () => {
    expect(epicOrchestratorLiveness([])).toBe(false);
  });
});

describe("restartRemedyFor", () => {
  // THE DEATH MODE THE FOUNDER'S MACHINE ACTUALLY PRODUCES. An intermittent DNS fault kills agents
  // in batches on `API Error: ... (ENOTFOUND)`; a restart is the right remedy and must not need a
  // human to notice.
  it("a transport death is restartable", () => {
    expect(restartRemedyFor("transport-transient")).toBe("restart");
  });

  // Restarting into an account wall cannot help — the door opens on the account's clock or on a
  // human raising a cap. This app has already measured what ignoring that costs: 2,273 account-wall
  // records, one session retrying into a closed door 45 times.
  it("both walls refuse a restart", () => {
    expect(restartRemedyFor("wall-session")).toBe("wall");
    expect(restartRemedyFor("wall-spend")).toBe("wall");
  });

  it("a human decision is not something to restart around", () => {
    expect(restartRemedyFor("blocked-on-human")).toBe("human");
    expect(restartRemedyFor("human-stopped")).toBe("human");
  });

  // Reads backwards until you note WHICH question is asked. `isResurrectable` refuses a met goal —
  // correctly, about the AGENT. This is about the EPIC, which the sweep has already established is
  // not done. 17 of the founder's 17 named orchestrators had goals reading `met` or `expired`.
  it("an orchestrator that marked its own goal met does NOT finish the epic", () => {
    expect(restartRemedyFor("clean-goal-met")).toBe("restart");
  });

  // Silence is not a wall. Reading a missing record as a refusal would switch the whole recovery off
  // on the strength of an absence — the same defect class this module fixes one level up.
  it("no death record at all still restarts", () => {
    expect(restartRemedyFor(undefined)).toBe("restart");
  });

  it("every remaining cause is restartable", () => {
    const rest: DeathCause[] = ["app-restart", "process-gone", "startup-no-show", "unknown"];
    for (const c of rest) expect(restartRemedyFor(c)).toBe("restart");
  });
});

describe("epicRestartRemedy", () => {
  it("one restartable agent beats a walled sibling", () => {
    expect(epicRestartRemedy(["wall-spend", "transport-transient"])).toBe("restart");
  });

  // A wall lifts on its own; re-asking the founder about an epic merely waiting out an account
  // limit is the false alarm the vocabulary exists to avoid.
  it("a wall outranks a human block when nothing is restartable", () => {
    expect(epicRestartRemedy(["blocked-on-human", "wall-session"])).toBe("wall");
  });

  it("only human blocks means the human decides", () => {
    expect(epicRestartRemedy(["human-stopped", "blocked-on-human"])).toBe("human");
  });

  it("nothing bound means no record can argue against a fresh agent", () => {
    expect(epicRestartRemedy([])).toBe("restart");
  });
});

// ══ A FINISHED ORCHESTRATOR IS NOT A WORKING ONE (bead sparkle-70cu4y) ═════════════════════════
// The second half of the same measured incident, and the half the hook-log join CANNOT see. An
// orchestrator that marked its own goal `met` is very much alive — its process is up, its pane reads
// `idle`, and its hook log is FRESH because it was writing commits minutes ago. So every witness
// this module joins answers "staffing", the epic sweep skips `orchestrator-alive` forever, and the
// three-alarm unstaffed count collapses to 0 while nothing at all is being built.
//
// `pusherMount.improveUnstaffedEpics` already fixed this for the NUDGE path with a local
// `agentIsFinished ? false : liveness` composition. The EPIC SWEEP — the thing that actually hands
// the epic back — never asked the question at all. These cases move the rule into the one shared
// staffing reading so the two surfaces cannot answer differently.
describe("a bound orchestrator that FINISHED is not staffing its epic", () => {
  // THE BUG. Fresh hook log, observed alive, goal met ⇒ every existing rule says `true`.
  it("a goal-quiet orchestrator with a FRESH hook log is NOT staffing", () => {
    expect(
      orchestratorLivenessOf(
        { observedAlive: true, goalQuiet: true, lastHookEventMs: NOW - 60_000 },
        NOW,
      ),
    ).toBe(false);
  });

  // ── A WORKING PANE OUTRANKS A MET GOAL (roborev 74192, High) ────────────────────────────────
  // `metAt` is a DURABLE LATCH, not a moment: an orchestrator that marked its goal met and was then
  // handed more work — a founder reply, a nudge, a resume — reads `met` forever while it builds.
  // The rule above, unguarded, outranked a FRESH reading of that agent actively producing output.
  //
  // The consequence is not a missed nudge. The consumer of `false` is a RESTART: sendToBuild pastes
  // a handoff into the live agent's PTY mid-turn, the epic burns its one sweep-restarted stamp, the
  // founder is told of a restart that should not have happened, and the epic lands in Blocked while
  // it is being actively built — "strictly worse than the bug", in this suite's own words.
  it("a goal-quiet orchestrator whose pane says WORKING is still staffing — a reading of NOW beats a latch about THEN", () => {
    expect(
      orchestratorLivenessOf(
        {
          observedAlive: true,
          goalQuiet: true,
          observedStatus: "working",
          lastHookEventMs: NOW - 60_000,
        },
        NOW,
      ),
    ).toBe(true);
  });

  // ── THE `working` LATCH ALONE IS NOT EVIDENCE (roborev 74412, High) ─────────────────────────
  // `observedStatus` is a NON-RETRACTING latch: AgentPane is its only writer and only `close()`
  // clears it — not unmount, not PTY death. `working` is not in processAliveFor's DEAD set either,
  // so an orchestrator killed mid-turn reads alive+working FOREVER. And `lastHookEventMs` is
  // PERMANENTLY null for a cloud agent or one with no worktree, so there is no clock to age it out.
  //
  // Exempting on the latch alone would therefore return `true` on every tick with nothing able to
  // retract it — `skip: orchestrator-alive` forever, the direction this file calls the expensive
  // one ("a wrong `true` cost 25 epics 121 hours each"). The exemption requires a FRESH measurement
  // to corroborate the pane, and this is the case the first two tests could not reach: both supply
  // a fresh hook stamp, so they exercise only the path that was already safe.
  it("a WORKING pane with NO hook stamp at all is NOT staffing — the latch cannot outlive the process", () => {
    expect(
      orchestratorLivenessOf(
        {
          observedAlive: true,
          goalQuiet: true,
          observedStatus: "working",
          lastHookEventMs: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("a WORKING pane whose hook stamp is STALE is NOT staffing — deferring to the log never goes past it", () => {
    expect(
      orchestratorLivenessOf(
        {
          observedAlive: true,
          goalQuiet: true,
          observedStatus: "working",
          lastHookEventMs: NOW - 6 * 60 * 60 * 1000,
        },
        NOW,
      ),
    ).toBe(false);
  });

  // PAIRED with the case above: the SAME fixture with an idle pane must still unstaff, or the guard
  // would just be switching the rule off rather than narrowing it to the silent population.
  it("PAIRED: the identical fixture with an IDLE pane is NOT staffing, so the guard narrows the rule rather than disabling it", () => {
    expect(
      orchestratorLivenessOf(
        {
          observedAlive: true,
          goalQuiet: true,
          observedStatus: "idle",
          lastHookEventMs: NOW - 60_000,
        },
        NOW,
      ),
    ).toBe(false);
  });

  // ── THE PAIRED CASE ─────────────────────────────────────────────────────────────────────────
  // Identical fixture, ONE fact different: the goal is still live. Without this the case above
  // passes for a module that calls every orchestrator dead — which would spawn a rival against
  // every epic somebody is actually building, strictly worse than the bug.
  it("the same orchestrator with a LIVE goal IS staffing", () => {
    expect(
      orchestratorLivenessOf(
        { observedAlive: true, goalQuiet: false, lastHookEventMs: NOW - 60_000 },
        NOW,
      ),
    ).toBe(true);
  });

  // NO GOAL RECORD IS NOT A QUIET GOAL. Most build agents carry no goal at all; reading an absent
  // record as "finished" would unstaff the entire fleet on the first tick.
  it("an orchestrator with no goal record at all is still staffing", () => {
    expect(
      orchestratorLivenessOf({ observedAlive: true, lastHookEventMs: NOW - 60_000 }, NOW),
    ).toBe(true);
  });

  // POSITIVE OBSERVATION IS REQUIRED, exactly as `pusherMount.agentIsFinished` requires it
  // (roborev 72653). `observedAlive` is `undefined` for every row after an app restart, and those
  // rows still carry a PERSISTED `metAt` from before it. Reading that as finished would unstaff
  // every epic in the store at once, on the strength of nobody having looked — which is the very
  // defect class this module exists to end.
  it("an UNOBSERVED orchestrator with a persisted quiet goal is judged by its hook log, not by the goal", () => {
    expect(
      orchestratorLivenessOf(
        { observedAlive: undefined, goalQuiet: true, lastHookEventMs: NOW - 60_000 },
        NOW,
      ),
    ).toBe(true);
  });

  // A LIVE PROMPT ON SCREEN OUTRANKS THE GOAL RECORD. `sendToBuild` on an already-live orchestrator
  // pastes the handoff into its PTY, so a grid that is reporting a prompt RIGHT NOW must keep the
  // epic staffed whatever the goal says — a goal marked met is not permission to answer a pending
  // permission dialog on the human's behalf.
  it("never unstaffs an orchestrator the grid sees sitting at a prompt", () => {
    expect(
      orchestratorLivenessOf(
        {
          observedAlive: true,
          goalQuiet: true,
          observedAttention: "awaiting",
          lastHookEventMs: NOW - 121 * HOUR,
        },
        NOW,
      ),
    ).toBe(true);
  });

  // The WAITING_ON_HUMAN arm keeps its answer unchanged: a latched wait with no corroborating grid
  // is `null` (`staffing-unknown`), which spends nothing. The goal record does not promote that to
  // a confident `false`, because the hazard the arm prevents is a PTY write and a quiet goal is no
  // evidence the PTY is gone.
  it("does not override the latched-wait arm", () => {
    expect(
      orchestratorLivenessOf(
        {
          observedAlive: true,
          goalQuiet: true,
          observedStatus: "waiting",
          lastHookEventMs: NOW - 60_000,
        },
        NOW,
      ),
    ).toBeNull();
  });

  // ANY genuinely working agent still staffs the epic. A finished orchestrator beside a live one is
  // not an unstaffed epic, and restarting it would be the rival spawn the tri-state exists to avoid.
  it("a finished orchestrator beside a working one leaves the epic staffed", () => {
    const finished = orchestratorLivenessOf(
      { observedAlive: true, goalQuiet: true, lastHookEventMs: NOW - 60_000 },
      NOW,
    );
    const working = orchestratorLivenessOf(
      { observedAlive: true, goalQuiet: false, lastHookEventMs: NOW - 60_000 },
      NOW,
    );
    expect(epicOrchestratorLiveness([finished, working])).toBe(true);
  });
});
