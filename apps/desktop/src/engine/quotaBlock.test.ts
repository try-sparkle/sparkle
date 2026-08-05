// The quota wall — the block that made agent 61a5332f ("Cockpit Column Resize") sit dead for a long
// stretch while every health surface in the app reported it healthy.
//
// THE OBSERVED FAILURE, from the founder's screenshot. The agent hit:
//
//     You've hit your session limit · resets 4pm (America/Bogota) — /usage-credits to finish what
//     you're working on.
//
// The never-idle auto-resume then fired repeatedly. Each resume printed the goal banner, hit the same
// wall, and ended the turn — "Baked for 14m 27s", "Sautéed for 1s", "Cogitated for 4s". Throughout,
// `get_agent_status` returned `status: "working"`, stall verdict `active`, detail "Working — tools are
// running and commands are not repeating."
//
// WHY EVERY SURFACE MISSED IT, and it is not that the detector was absent. `engine/apiRecovery`
// ALREADY classifies this exact string as a `terminal` (account-limit) failure, correctly and with
// tests. But that classifier is only ever consulted for an agent whose status is ALREADY `errored`
// (`decideRevive`: `if (status !== "errored") return { action: "none", reason: "not-errored" }`), and
// the only thing that sets `errored` mid-stream is `streamFailure`'s `^api error\s*:` anchor. A
// session-limit banner carries NO "API Error:" prefix — so the anchor never matched, the status never
// went red, and the working classifier was never reached. Detector present, status path never asked.
//
// These tests pin the three claims the fix has to make good on, at the level each one actually bit.
import { describe, it, expect, vi, afterEach } from "vitest";
import { StatusEngine } from "./statusEngine";
import { stallReport } from "./agentStall";
import { decideContinuation } from "./goalContinuation";
import { newGoal } from "./agentGoal";
import { quotaBlockIn, SESSION_LIMIT_FALLBACK_MS } from "./quotaBlock";
import type { AgentTabStatus } from "../types";

/** Verbatim from the founder's screenshot, including the trailing remedy clause. */
const SESSION_LIMIT =
  "You've hit your session limit · resets 4pm (America/Bogota) — /usage-credits to finish what you're working on.";

const SPINNER = "✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)";

function makeEngine() {
  const statuses: AgentTabStatus[] = [];
  const engine = new StatusEngine({ agentId: "test", onStatus: (s) => statuses.push(s) });
  return { engine, last: () => statuses[statuses.length - 1] };
}

describe("quotaBlockIn", () => {
  it("detects the session-limit banner and keeps the message VERBATIM", () => {
    const at = Date.parse("2026-07-30T18:00:00.000Z");
    const block = quotaBlockIn(`\r⏺ ${SESSION_LIMIT}`, at);
    // Verbatim, because this string is what the human is shown — a paraphrase loses the reset time
    // and the billing path that make it actionable.
    expect(block?.message).toBe(SESSION_LIMIT);
  });

  it("parses the reset instant out of the message rather than guessing", () => {
    // 18:00Z is 13:00 in America/Bogota (UTC-5), so "resets 4pm" is three hours out, same day.
    const at = Date.parse("2026-07-30T18:00:00.000Z");
    const block = quotaBlockIn(SESSION_LIMIT, at);
    expect(block?.resetAt).toBe(Date.parse("2026-07-30T21:00:00.000Z"));
    expect(block?.resetParsed).toBe(true);
  });

  it("falls back to a BOUNDED window when the message names no parseable reset", () => {
    // The monthly-spend shape carries a billing URL and no clock time. A bounded fallback is the
    // point: the founder's requirement is "if it cannot be parsed, fall back to a bounded backoff
    // rather than a tight loop".
    const at = Date.parse("2026-07-30T18:00:00.000Z");
    const block = quotaBlockIn(
      "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
      at,
    );
    expect(block?.resetParsed).toBe(false);
    expect(block?.resetAt).toBe(at + SESSION_LIMIT_FALLBACK_MS);
  });

  it("does NOT fire on an agent's own prose about session limits", () => {
    // This module's own write-up, a PRD, or an agent explaining the bug must not paint a row red —
    // the false-positive class `streamFailure`'s header says was deliberately designed out. Prose
    // wears a bullet or leading words, so the `^` anchor never sees the opener.
    const at = Date.now();
    expect(quotaBlockIn("- You've hit your session limit · resets 4pm (America/Bogota)", at)).toBeUndefined();
    expect(quotaBlockIn("I'll handle the case where you've hit your session limit.", at)).toBeUndefined();
    expect(quotaBlockIn("Wrote the session limit tests.", at)).toBeUndefined();
  });
});

describe("a quota-walled agent must not read healthy", () => {
  // DEFECT 1, at the status level. This is the assertion that fails against today's code: the
  // session-limit banner leaves the row `working`.
  it("goes blocked, not working, on a session-limit banner (the live unterminated shape)", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
    // No trailing newline and a "⏺ " assistant marker — verbatim the shape a live agent produces.
    engine.ingest(`\r⏺ ${SESSION_LIMIT}`);
    expect(last()).toBe("blocked");
    // A later spinner tick must not pull it back to green. The wall does not clear because the
    // terminal redrew — it clears at 4pm.
    engine.ingest(SPINNER);
    expect(last()).toBe("blocked");
  });

  // DEFECT 1, at the stall level. `stallReport` returns `active` for ANY non-quiet status, so a
  // quota-walled agent reporting `working` was reported "not idle" — which is true and useless.
  it("does not report the stall verdict 'active' while the wall is up", () => {
    const now = Date.parse("2026-07-30T18:00:00.000Z");
    const block = quotaBlockIn(SESSION_LIMIT, now);
    const report = stallReport({
      status: "working",
      now,
      goal: undefined,
      quotaBlock: block,
    });
    expect(report.verdict).not.toBe("active");
    expect(report.verdict).toBe("quota-blocked");
    // The reset time reaches the human verbatim — that is the whole actionable content.
    expect(report.detail).toContain("resets 4pm (America/Bogota)");
  });

  // DEFECT 3. "Any resume-driven output must not count as progress for stall purposes — otherwise
  // the recovery mechanism hides the very condition it is failing to recover from."
  //
  // The mechanism, precisely: `pty.deliverSubmit` calls `noteUserInputForAgent` for EVERY send, and
  // `StatusEngine.noteUserInput` treats that as "the user is here and driving" and clears the sticky
  // failure. The never-idle auto-resume goes through that same path, so each resume wiped the red it
  // had just failed to clear, the next spinner tick repainted the row green, and the loop looked like
  // a working agent. The machine erased its own evidence, every 45 seconds.
  it("a MACHINE resume does NOT clear the quota red", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest(`\r⏺ ${SESSION_LIMIT}`);
    expect(last()).toBe("blocked");
    // The auto-resume types the goal banner. Not a human — nobody has looked at this agent.
    engine.noteUserInput("GOAL: land the retry PR", { machine: true });
    engine.ingest(SPINNER);
    expect(last()).toBe("blocked");
  });

  it("a HUMAN typing DOES clear it — they are present and driving", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest(`\r⏺ ${SESSION_LIMIT}`);
    expect(last()).toBe("blocked");
    // Verbatim what the founder typed to get the agent going again.
    engine.noteUserInput("try again");
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
  });

  it("a machine resume still clears a TRANSIENT api failure — that contract is unchanged", () => {
    // apiRecoveryRunner deliberately relies on its own ping clearing `errored` so it can observe
    // whether the retry worked. Narrowing the clear to quota only must not disturb it.
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest("\r⏺ API Error: 529 Overloaded.");
    expect(last()).toBe("errored");
    engine.noteUserInput("continue", { machine: true });
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
  });

  it("stops being quota-blocked once the reset instant has passed", () => {
    const at = Date.parse("2026-07-30T18:00:00.000Z");
    const block = quotaBlockIn(SESSION_LIMIT, at);
    const afterReset = Date.parse("2026-07-30T21:00:01.000Z");
    const report = stallReport({
      status: "working",
      now: afterReset,
      goal: undefined,
      quotaBlock: block,
    });
    // The wall is down, so this surface goes back to having no opinion about a working row.
    expect(report.verdict).toBe("active");
  });
});

// THE WALL MUST BE RELEASED, and by two different events — the review of the first cut found that
// neither happened, so an agent that went `blocked` stayed blocked forever.
//
// The bug these pin, exactly: tripping the wall pins the row to `blocked` and clears the settle
// timer. `blocked` is not a resting status, so `decideContinuation` refuses with `not-idle` long
// before any quota gate is consulted — and nothing else clears the sticky red, because a walled agent
// runs no tools and produces no prompt. So when 4pm arrived, nothing resumed the agent: it sat dead
// until a human typed "try again", which is verbatim the failure this branch exists to remove.
//
// The first cut's own test could not see this: it injected `status: "idle"`, a state that cannot
// co-exist with a freshly-tripped wall, so it asserted a true thing about an input shape the system
// never produces. These drive the real object instead.
describe("the wall is released", () => {
  afterEach(() => vi.useRealTimers());

  it("releases itself when the stated reset arrives, with no new output to wake it", () => {
    // The agent is walled and therefore SILENT — nothing will arrive to re-classify the row. If the
    // release depends on output, it never happens.
    vi.useFakeTimers();
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest(`\r⏺ ${SESSION_LIMIT}`);
    expect(last()).toBe("blocked");

    // Advance past the reset with ZERO further ingest.
    vi.advanceTimersByTime(quotaBlockIn(SESSION_LIMIT, Date.now())!.resetAt - Date.now() + 1_000);
    expect(last()).not.toBe("blocked");
    expect(engine.quotaBlockNow(Date.now())).toBeUndefined();
  });

  // THE WALL OUTLIVES `failureKind`, SO THE MACHINE GUARD MUST NOT DEPEND ON IT.
  //
  // The first version gated the guard on `opts.machine === true && failureKind === "quota"`, which
  // reads as "a machine send never reaches the release for a quota failure" — true only while the
  // sticky red is still latched. It is trivially unlatched: `ingest` checks for an input prompt
  // BEFORE the stream-failure arm, and that path calls `clearStreamFailure()`, which nulls
  // `failureKind`. Claude Code printing the limit banner and then redrawing its input box does
  // exactly that. From there any programmatic sender — requery (whose SAFE_TO_REQUERY includes
  // `blocked`), fleetWatch, apiRecoveryRunner, a machine dispatch — nulled a LIVE wall, and
  // auto-resume fired into it again: the self-concealing loop, through the door the fix had just
  // claimed to close.
  it("a machine send does NOT null a live wall once the red has cleared for other reasons", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest(`\r⏺ ${SESSION_LIMIT}`);
    expect(engine.quotaBlockNow(Date.now())).toBeDefined();

    // A real interactive prompt appears. This is an ordinary recovery path — it calls
    // `clearStreamFailure()`, so `failureKind` is no longer "quota" — while the WALL is still up.
    // The status flip to `waiting` is what PROVES the state was reached: an earlier version of this
    // test used an input-box redraw, which left the row `blocked` (failureKind intact) and therefore
    // passed without ever exercising the rule it names.
    engine.ingest(
      "\n│ Do you want to make this edit to foo.ts?           │\n│ ❯ 1. Yes                                           │\n",
    );
    expect(last()).toBe("waiting");
    expect(engine.quotaBlockNow(Date.now())).toBeDefined();

    // Now a programmatic sender arrives. It must not be able to retire the wall.
    engine.noteUserInput("continue", { machine: true });
    expect(engine.quotaBlockNow(Date.now())).toBeDefined();
  });

  it("does not leave a multi-hour timer pending after dispose", () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest(`\r⏺ ${SESSION_LIMIT}`);
    const armed = vi.getTimerCount();
    expect(armed).toBeGreaterThan(0);
    engine.dispose();
    // A torn-down engine "must go completely silent" — and a 5h timer retaining the engine and its
    // closure, once per open/close cycle of a walled agent, is neither silent nor free.
    expect(vi.getTimerCount()).toBe(0);
  });

  // NO TERMINAL TEXT RETIRES THE WALL — the inverse of what three earlier versions of this file
  // asserted, and the conclusion of four review rounds.
  //
  // The goal was to let an out-of-band cap raise clear the wall early. Every text signal tried for
  // it turned out to be a FALSE RELEASE, which is the direction that resurrects the resume loop:
  // any classified event (classifyLine is a RISK classifier, so recap prose qualifies); excluding
  // approval_needed (that drops only CAUTION/DANGEROUS, while SAFE *is* the prose surface); a
  // leading shell prompt (SHELL_PROMPT is /^\s*[$#>]\s+/, so "# Summary" and any Makefile comment
  // qualify — and `⎿ $ touch probe_ok.txt` in capturedScreens.fixture sits INSIDE the permission
  // dialog, so it is a command PROPOSED, not run).
  //
  // So the wall now falls to exactly two sound signals: its stated reset, and a human send.
  it("is not retired by ANY terminal text — prose, commands, or a proposed command", () => {
    for (const text of [
      "⏺ Next I'll run npm test and then commit.",
      "⏺ Done: ran vitest and committed the fix.",
      "⏺ Reading file src/foo.ts to see what changed.",
      "# Summary",
      "# install deps first",
      "$ git commit -m 'land the retry PR'",
      // Verbatim the shape that was wrongly cited as proof of execution: a command sitting in an
      // UNANSWERED permission dialog. The agent has run nothing.
      "  ⎿  $ touch probe_ok.txt",
      "$ rm -rf build",
    ]) {
      const { engine } = makeEngine();
      engine.ingest(SPINNER);
      engine.ingest(`\r⏺ ${SESSION_LIMIT}`);
      engine.ingest(`\n${text}\n`);
      expect(engine.quotaBlockNow(Date.now()), text).toBeDefined();
    }
  });

  it("also releases when a HUMAN types, even with no tool output at all", () => {
    // The other evidence path, kept separate so neither can masquerade as the other.
    const { engine } = makeEngine();
    engine.ingest(SPINNER);
    engine.ingest(`\r⏺ ${SESSION_LIMIT}`);
    expect(engine.quotaBlockNow(Date.now())).toBeDefined();
    engine.noteUserInput("try again");
    expect(engine.quotaBlockNow(Date.now())).toBeUndefined();
  });
});

// EVERY PROGRAMMATIC SENDER, not just the auto-resume. Defect 3 was first closed only on the
// `conciergeDispatch` paths, which left the same hole open one door over — and `requery` is the sharp
// case, because its `SAFE_TO_REQUERY` set explicitly contains `"blocked"`. So on any offline→online
// transition it fired a prompt at exactly the quota-walled rows, claimed human presence, cleared the
// red, and the next spinner tick repainted the row green: the self-concealing loop, re-entered.
//
// This is a SOURCE-TEXT assertion rather than a behavioural one on purpose. The property is "no
// programmatic sender forgets to declare itself", which is about the whole set of call sites; a
// behavioural test would cover the two we remembered and stay green for the next one added. The
// compile-time counterpart is that `submitPrompt`'s option is REQUIRED — see pty.ts.
describe("no programmatic sender claims human presence", () => {
  it("requery and fleetWatch both declare machine sends", async () => {
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const here = url.fileURLToPath(new URL(".", import.meta.url));
    for (const rel of ["../services/requery.ts", "../services/fleetWatch.ts"]) {
      const src = await fs.readFile(`${here}${rel}`, "utf8");
      const calls = src.match(/submitPrompt\([^)]*\)/gs) ?? [];
      expect(calls.length, `${rel} should still call submitPrompt`).toBeGreaterThan(0);
      for (const c of calls) expect(c, `${rel}: ${c}`).toContain("machine: true");
    }
  });
});

// THE CHIP MUST BE REACHABLE. The sidebar builds its OWN stall/thrash readings rather than going
// through agentGoalReading, so adding a "Rate limited" label to the chip table did nothing: neither
// sidebar call passed a wall, the verdict could never be produced there, and the surface the founder
// actually watches still showed a red row with no reason. Dead labels are worse than no label —
// they read as coverage.
describe("the sidebar can actually show the wall", () => {
  it("produces the Rate limited chip from a quota reading", async () => {
    const { thrashChipLabel } = await import("../components/rowAttention");
    const { thrashReport, initialThrashState } = await import("./agentThrash");
    const now = Date.parse("2026-07-30T18:00:00.000Z");
    const report = thrashReport(initialThrashState(), now, {
      goalOutstanding: true,
      quotaBlock: quotaBlockIn(SESSION_LIMIT, now),
    });
    expect(thrashChipLabel(report)).toBe("Rate limited");
  });

  it("threads the wall into BOTH readings the sidebar computes for a row", async () => {
    // Source-text, for the same reason as the programmatic-sender check: the property is about the
    // call sites existing at all, and a behavioural test would need the whole sidebar mounted with a
    // live StatusEngine registered to prove a wiring line is present.
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const here = url.fileURLToPath(new URL(".", import.meta.url));
    const src = await fs.readFile(`${here}../components/AgentSidebar.tsx`, "utf8");
    // Twice for the two stallInputsFor sites, once for thrashReportFor.
    expect(src.match(/quotaBlockForAgent\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

// DEFECT 2. "Resuming instantly into a limit whose reset time is stated IN THE ERROR is guaranteed
// waste — it burns turns, pollutes scrollback, and makes the agent look busy. Back off until the
// stated reset, then resume ONCE automatically."
// THE ECHO WINDOW, tested through the consumer that still depends on it.
//
// The wall no longer falls to any terminal text, so the assertion that USED to cover this guard
// ("the wall stays up") went vacuous and was deleted with the release it tested. The guard itself was
// deliberately KEPT — it protects the false-red machinery, not just the wall — and deleting its only
// test left it green under reversion. This is the replacement, and it asserts the DOWNSTREAM SIDE
// EFFECT rather than a precondition.
//
// The mechanism: `notedUserText` holds the whole submitted message and `isUserEchoLine` matches one
// line as a FRAGMENT of it, because a multi-line message echoes line by line. If the window is
// cleared on the echo's own first line, lines 2+ lose echo protection — and a relay containing a
// self-prompt phrase then trips `StreamFailureDetector`'s churn rule and paints a healthy agent RED.
describe("the user-input echo window survives its own multi-line echo", () => {
  it("does not go errored when a multi-line relay echoes a self-prompt phrase back", () => {
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER);
    expect(last()).toBe("working");
    // Line 1 CLASSIFIES (`Reading file` is in the SAFE set), which is what reaches the clear inside
    // the `if (ev)` arm. Lines 2-3 are a self-prompt phrase, which trips the churn wedge at two
    // occurrences — but only if they are no longer recognised as this relay's own echo.
    const relay = "Reading file src/foo.ts\nAre you there?";
    engine.noteUserInput(relay, { machine: true });
    engine.ingest("\nReading file src/foo.ts\nAre you there?\nAre you there?\n");
    expect(last()).not.toBe("errored");
  });
});

describe("auto-resume backs off until the wall comes down", () => {
  const AT = Date.parse("2026-07-30T18:00:00.000Z");
  const RESET = Date.parse("2026-07-30T21:00:00.000Z");

  /** Everything `decideContinuation` needs to say "continue" — so each test below varies only the
   *  one thing it is about, and a refusal can only be the quota gate. */
  function readyToResume(now: number) {
    return {
      // TTL WIDER THAN THE FALLBACK WINDOW, deliberately, so these tests isolate the quota gate.
      //
      // Worth knowing rather than hiding: the default goal TTL is 4h and the unparseable-reset
      // fallback is 5h, so in production a spend-cap block usually outlives the goal and the agent
      // stops being resumed because the goal EXPIRED, not because the wall came down. That is the
      // existing TTL contract working as designed (it bounds spend, per agentGoal.DEFAULT_GOAL_TTL_MS)
      // and not something this change should quietly alter — but it does mean "resume once the wall
      // lifts" only actually fires for a parseable reset inside the TTL, which every *session* limit
      // is (the window is 5h and the message always names the time).
      goal: newGoal("land the retry PR", AT, 8 * 60 * 60 * 1000),
      status: "idle" as const,
      now,
      idleSince: now - 120_000,
      hasTurnEndAuthority: true,
      canAcceptInput: true,
      processAlive: true,
      mark: "m",
      // A LOCAL agent — the quota wall this suite is about is an account limit an agent reports from
      // its own terminal, which is a local-runtime signal. Cloud evidence is `undefined` accordingly.
      runtime: "local" as const,
      cloud: undefined,
    };
  }

  it("refuses to resume while the wall is up, naming the wall as the reason", () => {
    const decision = decideContinuation({
      ...readyToResume(AT + 60_000),
      quotaBlock: quotaBlockIn(SESSION_LIMIT, AT),
    });
    expect(decision).toEqual({ action: "none", reason: "quota-blocked" });
  });

  // THE STATE THE SYSTEM ACTUALLY PRODUCES. A tripped wall forces `status: "blocked"`, so every test
  // here that passes `status: "idle"` alongside a live wall describes a combination that cannot
  // occur. `blocked` fails `isRestingStatus`, so the ORDER of the gates decides which reason comes
  // out — and "not-idle" is exactly the uninformative answer this whole branch exists to replace.
  it("says quota-blocked, NOT not-idle, for the blocked row a real wall produces", () => {
    const decision = decideContinuation({
      ...readyToResume(AT + 60_000),
      status: "blocked",
      quotaBlock: quotaBlockIn(SESSION_LIMIT, AT),
    });
    expect(decision).toEqual({ action: "none", reason: "quota-blocked" });
  });

  it("resumes once the stated reset has passed", () => {
    const decision = decideContinuation({
      ...readyToResume(RESET + 1_000),
      quotaBlock: quotaBlockIn(SESSION_LIMIT, AT),
    });
    expect(decision.action).toBe("continue");
  });

  it("still backs off — bounded, not tight — when the message names no parseable reset", () => {
    const spend = quotaBlockIn(
      "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
      AT,
    );
    // Inside the bounded fallback window: refused.
    expect(decideContinuation({ ...readyToResume(AT + 60_000), quotaBlock: spend }).action).toBe(
      "none",
    );
    // Past it: allowed to try again, rather than being blocked forever on a guess.
    expect(
      decideContinuation({
        ...readyToResume(AT + SESSION_LIMIT_FALLBACK_MS + 1_000),
        quotaBlock: spend,
      }).action,
    ).toBe("continue");
  });

  it("does not spend a retry from the budget while it is backing off", () => {
    // The bound that escalates to a human is `MAX_CONTINUES_WITHOUT_PROGRESS`. A refusal must be a
    // `none`, never a `continue` that burns an attempt — otherwise waiting out a 4-hour wall would
    // exhaust the budget and page the founder with "restarting cannot fix this", which is true but
    // arrives having wasted every retry the agent had.
    const blocked = decideContinuation({
      ...readyToResume(AT + 60_000),
      quotaBlock: quotaBlockIn(SESSION_LIMIT, AT),
    });
    expect(blocked.action).not.toBe("continue");
    expect(blocked.action).not.toBe("escalate");
  });
});
