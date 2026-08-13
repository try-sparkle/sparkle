// The FOURTH answer outcome: a prompt handed to the CONCIERGE rather than to the founder.
//
// Driven through the real `notePromptEpisodes` → `withBlockedPromptGrace` pair, and through the real
// `nextPromptGraceExpiry`, exactly as `blockedPromptGrace.test.ts` is — a ledger written by hand is
// a ledger the production stamper never has to agree with, and the stamping rule is the half most
// likely to be wrong.
//
// NO FAKE TIMERS ANYWHERE, and that is not a stylistic preference: every function under test takes
// `now` as an argument precisely so a four-minute ceiling can be asserted in microseconds and so the
// two clocks (`isHeld`'s and `nextPromptGraceExpiry`'s) can be interrogated at the SAME instant. A
// faked global clock would test the harness's notion of time rather than the module's.
//
// Every case here is one that goes red against the module as it was before `escalated` existed —
// where an unknown outcome was `!== "handled"`, which both surfaced the prompt at once and latched
// the give-up for the rest of the ask. The two exceptions are labelled: the `declined` /
// `unreachable` cases are deliberate REGRESSION GUARDS on the property that must not change, and the
// late-escalation case guards a bound this change introduces.
import { describe, expect, it } from "vitest";

import {
  BLOCKED_PROMPT_GRACE_MS,
  CONCIERGE_ESCALATION_GRACE_MS,
  emptyPromptGraceLedger,
  nextPromptGraceExpiry,
  notePromptAnswerOutcome,
  notePromptEpisodes,
  withBlockedPromptGrace,
  type PromptAsk,
  type PromptGraceLedger,
} from "./blockedPromptGrace";
import type { AgentTabStatus } from "../types";

const T0 = 1_700_000_000_000;
const AGENT = [{ id: "a" }];
const PROMPT = "Bash command\n\n  git status\n\nDo you want to proceed?\n 1. Yes\n 2. No";
/** The tight cap in the engine, for an open with nothing reported about the previous question.
 *  Mirrored so the cap test asserts the real boundary rather than "some finite amount". */
const CHURN_CAP = 2;

/** Explicit "the caller captured no screen at all" — a bare `undefined` argument would select the
 *  default below rather than overriding it. Same sentinel, same reason, as the sibling suite. */
const NO_ASK = "no-ask" as const;

/** Run one tick of the production pair and return the published status for `a`. */
function tick(
  ledger: PromptGraceLedger,
  status: AgentTabStatus,
  now: number,
  ask: PromptAsk | typeof NO_ASK = { text: PROMPT, at: T0 },
): AgentTabStatus | undefined {
  const map: Record<string, AgentTabStatus> = { a: status };
  notePromptEpisodes(ledger, map, () => (ask === NO_ASK ? undefined : ask), now, ["a"]);
  return withBlockedPromptGrace(AGENT, map, ledger, now)["a"];
}

/** A ledger holding one agent at a drawn, held approval prompt whose window began at {@link T0}. */
function heldAtT0(): PromptGraceLedger {
  const ledger = emptyPromptGraceLedger();
  expect(tick(ledger, "approval", T0 + 1_000)).toBe("idle");
  return ledger;
}

describe("escalated: the hold survives, on a LONGER ceiling", () => {
  it("is still held a minute in — long past the thirty seconds that would have surfaced it", () => {
    // THE CONTROL FIRST, so this cannot pass against a build where nothing is held at all. The same
    // prompt, the same clock, with no outcome reported: the ordinary ceiling has lapsed and the
    // founder has it.
    expect(tick(emptyPromptGraceLedger(), "approval", T0 + 60_000)).toBe("approval");

    const ledger = heldAtT0();
    notePromptAnswerOutcome("a", "escalated", T0 + 2_000, ledger);
    // Sixty seconds: double the ordinary ceiling, and the concierge's own channel could not have
    // answered yet (a two-minute floor between proactive turns). Still calm.
    expect(tick(ledger, "approval", T0 + 60_000)).toBe("idle");
  });

  it("is still held at 239s and surfaced at 241s — the escalation ceiling is real and finite", () => {
    const ledger = heldAtT0();
    notePromptAnswerOutcome("a", "escalated", T0 + 2_000, ledger);
    // One second inside the ceiling …
    expect(tick(ledger, "approval", T0 + CONCIERGE_ESCALATION_GRACE_MS - 1_000)).toBe("idle");
    // … and past it the founder gets the question, whatever the concierge is or is not doing. This
    // is the whole safety property: a concierge that is wedged, out of credits or simply wrong emits
    // nothing at all, so no outcome will ever end this hold and only the clock can.
    expect(tick(ledger, "approval", T0 + CONCIERGE_ESCALATION_GRACE_MS + 1_000)).toBe("approval");
  });

  it("arms the wake-up at the ESCALATION ceiling, not the ordinary one", () => {
    // THE SINGLE MOST IMPORTANT CASE IN THIS FILE. A ceiling with nothing to wake it is not a
    // ceiling: `now` arrives as an argument, and a prompt whose answerer has gone quiet produces no
    // status write, no outcome and no further event — so if the timer is armed at thirty seconds it
    // fires once, finds the prompt still held at four minutes, and NOTHING EVER RE-EVALUATES the
    // memo again. The prompt is then hidden forever, which is strictly worse than never having
    // escalated it.
    const ledger = heldAtT0();
    notePromptAnswerOutcome("a", "escalated", T0 + 2_000, ledger);
    expect(nextPromptGraceExpiry(AGENT, ledger, T0 + 3_000)).toBe(T0 + CONCIERGE_ESCALATION_GRACE_MS);
    // Spelled out as the negative too, because the failure this guards is precisely the wake-up
    // landing on the OTHER constant.
    expect(nextPromptGraceExpiry(AGENT, ledger, T0 + 3_000)).not.toBe(T0 + BLOCKED_PROMPT_GRACE_MS);
    // And the two clocks agree at the instant it fires: nothing is held, so nothing is armed.
    expect(tick(ledger, "approval", T0 + CONCIERGE_ESCALATION_GRACE_MS)).toBe("approval");
    expect(nextPromptGraceExpiry(AGENT, ledger, T0 + CONCIERGE_ESCALATION_GRACE_MS)).toBeNull();
  });

  it("an un-escalated held prompt still arms at THIRTY seconds — the longer clock is not global", () => {
    // The paired opposite. Without this, moving every ceiling to four minutes would pass the case
    // above while quietly hiding every ordinary prompt for eight times as long.
    const ledger = heldAtT0();
    expect(nextPromptGraceExpiry(AGENT, ledger, T0 + 1_000)).toBe(T0 + BLOCKED_PROMPT_GRACE_MS);
  });
});

describe("escalated is NOT a give-up", () => {
  it("does not latch `gaveUp`, so the next redraw of the same ask is still held", () => {
    // The latch exists to stop a prompt the FOUNDER has been made responsible for from sliding back
    // into hiding on the next repaint. An escalation says the opposite — a third party took it — so
    // latching it would force-surface the question at the first churned redraw, ~3.5 minutes before
    // its own ceiling was due, and the escalation would buy nothing at all.
    const ledger = heldAtT0();
    notePromptAnswerOutcome("a", "escalated", T0 + 2_000, ledger);
    // A redraw whose key churns (a trailing file count is not normalised), so the burn set cannot
    // decide this — only the latch could. It must not.
    expect(
      tick(ledger, "approval", T0 + 3_000, { text: `${PROMPT}\n7 files`, at: T0 + 3_000 }),
    ).toBe("idle");
    // And it stays that way across a further churn — with the answerer escalating the redrawn
    // question too, which is what actually happens: it sees the prompt again and passes it on
    // again. WITHOUT that second report the third open is refused by the CHURN BUDGET rather than
    // by the latch (nothing was reported about the question being replaced, so it gets the tight
    // cap of two), which is correct and is a different rule — asserting it here would have pinned
    // the budget while claiming to pin the latch.
    notePromptAnswerOutcome("a", "escalated", T0 + 3_500, ledger);
    expect(
      tick(ledger, "approval", T0 + 4_000, { text: `${PROMPT}\n14 files`, at: T0 + 4_000 }),
    ).toBe("idle");
  });

  it("a give-up latched BEFORE an escalation still wins — the escalation cannot un-decline it", () => {
    // The safe direction, asserted rather than assumed. Once `declined` has put the question in
    // front of the founder, a later `escalated` must not take it back out of his list.
    const ledger = heldAtT0();
    notePromptAnswerOutcome("a", "declined", T0 + 2_000, ledger);
    expect(tick(ledger, "approval", T0 + 2_500)).toBe("approval");
    notePromptAnswerOutcome("a", "escalated", T0 + 3_000, ledger);
    expect(tick(ledger, "approval", T0 + 3_500)).toBe("approval");
  });

  it("earns the GENEROUS hold cap, like `handled` — an answerer engaged with the question", () => {
    // Both outcomes carry the same evidence about a re-open: an answerer looked at the previous
    // question and disposed of it, so a different question appearing now is probably genuinely the
    // next one rather than the old one redrawn. Under the tight cap the third distinct question in
    // one budget window goes straight to the founder — which would hit hardest exactly the agent
    // whose prompts are hard enough to need escalating.
    const ledger = emptyPromptGraceLedger();
    const seen: (AgentTabStatus | undefined)[] = [];
    for (let i = 0; i <= CHURN_CAP; i++) {
      const at = T0 + i * 1_000;
      seen.push(tick(ledger, "approval", at, { text: `Bash: q${i}\nProceed?`, at }));
      notePromptAnswerOutcome("a", "escalated", at + 1, ledger);
    }
    // Three distinct questions, three holds — the tight cap of two would have made the last one red.
    expect(seen).toEqual(["idle", "idle", "idle"]);
  });

  it("…and `handled` still earns it too — widening the arm must not evict its original member", () => {
    // The paired half, and it is here because a mutation check proved it was needed: with only the
    // escalated case above, the engine's `outcome === "handled" || outcome === "escalated"` could
    // have its FIRST comparison inverted and every test still passed. `escalated` joining that arm
    // is worthless if it pushed `handled` out of it — that would put the routine burst this whole
    // module exists for (`git status` → `ls` → `cargo check`) back into the founder's list.
    //
    // `mutation-check --line` still reports that engine line uncaught, and that verdict is an
    // EQUIVALENT MUTANT rather than a hole: the script swaps both `===` at once, producing a
    // tautology whose only new members (`declined`/`unreachable`) are already refused by the
    // `gaveUp` latch. Each arm was mutated by hand instead — remove either one and this case or the
    // one above goes red. The engine comment records the same thing next to the line.
    const ledger = emptyPromptGraceLedger();
    const seen: (AgentTabStatus | undefined)[] = [];
    for (let i = 0; i <= CHURN_CAP; i++) {
      const at = T0 + i * 1_000;
      seen.push(tick(ledger, "approval", at, { text: `Bash: h${i}\nProceed?`, at }));
      notePromptAnswerOutcome("a", "handled", at + 1, ledger);
    }
    expect(seen).toEqual(["idle", "idle", "idle"]);
  });
});

describe("the outcomes that must NOT change", () => {
  // Regression guards. These pass against the module as it was, and that is the point: adding an arm
  // to a union is exactly the change that quietly re-routes its neighbours.
  it("`declined` still surfaces immediately", () => {
    const ledger = heldAtT0();
    notePromptAnswerOutcome("a", "declined", T0 + 2_000, ledger);
    expect(tick(ledger, "approval", T0 + 2_500)).toBe("approval");
    // …and arms nothing, because there is nothing left to wake up for.
    expect(nextPromptGraceExpiry(AGENT, ledger, T0 + 2_500)).toBeNull();
  });

  it("`unreachable` still surfaces immediately", () => {
    const ledger = heldAtT0();
    notePromptAnswerOutcome("a", "unreachable", T0 + 2_000, ledger);
    expect(tick(ledger, "approval", T0 + 2_500)).toBe("approval");
    expect(nextPromptGraceExpiry(AGENT, ledger, T0 + 2_500)).toBeNull();
  });

  it("the OVERLAY itself surfaces a give-up, without waiting for another episode pass", () => {
    // The same property as the two above, reached by the other road — and the mutation check is what
    // showed the two were not the same test. Every case above re-runs `notePromptEpisodes` first, so
    // the `gaveUp` LATCH has already ended the hold by the time the overlay looks, and `isHeld`'s own
    // outcome test is never the thing that decides. It has to be: `notePromptAnswerOutcome` notifies
    // subscribers synchronously, so a consumer can redraw from this ledger before any further
    // episode pass runs — and `nextPromptGraceExpiry` is called by a hook of its own, on no episode
    // pass at all. If only the latch worked, a decline would surface on the NEXT feed rebuild
    // instead of now, which is the delay the immediate-surfacing rule exists to remove.
    const ledger = heldAtT0();
    const map: Record<string, AgentTabStatus> = { a: "approval" };
    expect(withBlockedPromptGrace(AGENT, map, ledger, T0 + 1_500)["a"]).toBe("idle"); // still held
    notePromptAnswerOutcome("a", "declined", T0 + 2_000, ledger);
    // No `notePromptEpisodes` between the write and this read — the latch cannot have been set.
    expect(withBlockedPromptGrace(AGENT, map, ledger, T0 + 2_500)["a"]).toBe("approval");
    expect(nextPromptGraceExpiry(AGENT, ledger, T0 + 2_500)).toBeNull();
  });

  it("`handled` still keeps the hold on the ORDINARY ceiling", () => {
    // The arm most at risk of being widened by accident: `escalated` extends the ceiling, and the
    // cheapest way to write that is a test on "an outcome was reported", which would give a
    // delivered answer four minutes it has no use for.
    const ledger = heldAtT0();
    notePromptAnswerOutcome("a", "handled", T0 + 2_000, ledger);
    expect(tick(ledger, "approval", T0 + 3_000)).toBe("idle");
    expect(nextPromptGraceExpiry(AGENT, ledger, T0 + 3_000)).toBe(T0 + BLOCKED_PROMPT_GRACE_MS);
    expect(tick(ledger, "approval", T0 + BLOCKED_PROMPT_GRACE_MS)).toBe("approval");
  });
});

describe("bounds on when an escalation may extend anything", () => {
  it("an escalation arriving AFTER the row surfaced does not retract it", () => {
    // Guards a bound this change introduces, not the old behaviour. Past the ordinary ceiling the
    // question is already in the founder's list and he may be reading it; extending the ceiling then
    // does not delay a surfacing, it RETRACTS one that already happened — a four-minute version of
    // the very flicker this module exists to remove.
    const ledger = heldAtT0();
    expect(tick(ledger, "approval", T0 + BLOCKED_PROMPT_GRACE_MS + 1_000)).toBe("approval");
    notePromptAnswerOutcome("a", "escalated", T0 + BLOCKED_PROMPT_GRACE_MS + 1_500, ledger);
    expect(tick(ledger, "approval", T0 + BLOCKED_PROMPT_GRACE_MS + 2_000)).toBe("approval");
    expect(nextPromptGraceExpiry(AGENT, ledger, T0 + BLOCKED_PROMPT_GRACE_MS + 2_000)).toBeNull();
  });

  it("an escalation that PREDATES the episode buys the next question nothing", () => {
    // Same scoping every other outcome test in this module gets: an outcome filed about an earlier
    // question must not silently hand four minutes to a later one.
    const ledger = emptyPromptGraceLedger();
    notePromptAnswerOutcome("a", "escalated", T0 - 5_000, ledger);
    expect(tick(ledger, "approval", T0 + 1_000)).toBe("idle"); // held, on the ordinary clock
    expect(nextPromptGraceExpiry(AGENT, ledger, T0 + 1_000)).toBe(T0 + BLOCKED_PROMPT_GRACE_MS);
    expect(tick(ledger, "approval", T0 + BLOCKED_PROMPT_GRACE_MS)).toBe("approval");
  });

  it("an escalated prompt that leaves the ask is not held again on its next appearance", () => {
    // The never-twice rule is not weakened by the longer ceiling: the identity is burned by the
    // first hold, so a re-raised identical question goes red on sight however it was disposed of.
    const ledger = heldAtT0();
    notePromptAnswerOutcome("a", "escalated", T0 + 2_000, ledger);
    expect(tick(ledger, "working", T0 + 3_000)).toBe("working"); // leaves the ask
    expect(tick(ledger, "approval", T0 + 4_000, { text: PROMPT, at: T0 + 4_000 })).toBe("approval");
  });
});
