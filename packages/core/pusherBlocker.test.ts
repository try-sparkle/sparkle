import { describe, expect, it } from "vitest";
import {
  BLOCKER_ASK,
  BLOCKER_FENCE,
  BLOCKER_STATES,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  TRANSIENT_RETRY_LIMIT,
  UNMOVED_PUSH_LIMIT,
  MAX_QUOTED_DETAIL,
  MAX_SILENCE_MS,
  buildAsk,
  isBlockerState,
  isTransientFailure,
  parseBlockerReport,
  retryDelayMs,
  routeBlocker,
  routeAccountLimit,
  routeSilence,
  type BlockerReport,
  type BlockerState,
} from "./pusherBlocker";
import { checkCitations, numbersIn } from "./pusherGate";

/** A reply shaped the way an agent actually answers: prose, then the block. */
function reply(state: string, next?: string): string {
  return (
    "I rebased onto origin/main and re-ran the suite; 3 of 4 shards are green.\n\n" +
    "```bash\npnpm -r test\n```\n\n" +
    "```" +
    BLOCKER_FENCE +
    "\n" +
    `blocked: ${state}\n` +
    (next === undefined ? "" : `next: ${next}\n`) +
    "```\n"
  );
}

const ctx = (over: Partial<Parameters<typeof routeBlocker>[1]> = {}) => ({
  label: "Mount Tells The Truth",
  unmovedPushes: 0,
  now: 1_000,
  ...over,
});

describe("the ask", () => {
  it("names merging and forbids a question back — the two failures of the prompt it replaces", () => {
    // The old prompt asked "where things stand", and four agents answered with a narrative and
    // stopped, several ending by asking the founder a question. Both are addressed in the text
    // itself, so a change that loosens the wording fails here rather than in production.
    expect(BLOCKER_ASK).toMatch(/BLOCKING you from merging/);
    expect(BLOCKER_ASK).toMatch(/do not ask me a question back/i);
    expect(BLOCKER_ASK).toMatch(/WITHOUT asking/);
    expect(BLOCKER_ASK).not.toMatch(/where things stand/i);
  });

  it("no longer claims the network came back, because it is not sent on that edge any more", () => {
    expect(BLOCKER_ASK).not.toMatch(/back online/i);
  });

  it("shows every state it will accept, so an agent copies the vocabulary rather than paraphrasing", () => {
    for (const s of BLOCKER_STATES) expect(BLOCKER_ASK).toContain(s);
  });

  it("carries NO digits, so appending it to a challenge cannot trip the citation gate", () => {
    // Not cosmetic. `checkCitations` refuses any number not in the trigger's `measured` list, so a
    // numbered list here would fail the WHOLE challenge — the agent receives nothing, silently,
    // while the trigger burns its cooldown on a message the gate ate.
    expect(numbersIn(BLOCKER_ASK)).toEqual([]);
  });

  it("survives the real gate when appended to a real trigger's challenge", () => {
    const measured = ["3", "12"];
    const challenge = `Your goal expired 3h 12m ago and is still unmet.\n\n${BLOCKER_ASK}`;
    expect(checkCitations(challenge, measured)).toEqual({ ok: true, cited: ["3", "12"] });
  });

  it("embeds a block that this parser deliberately does NOT read as an answer", () => {
    // The ask contains a literal example of the block. If the parser accepted it, every transcript
    // would parse to the placeholder — see the "last block wins" rule.
    expect(parseBlockerReport(BLOCKER_ASK, 1)).toBeUndefined();
  });
});

describe("parsing", () => {
  it.each(BLOCKER_STATES)("reads %s out of a real reply", (state) => {
    const got = parseBlockerReport(reply(state, "pushing now"), 7);
    expect(got).toEqual({ state, detail: "pushing now", at: 7 });
  });

  it("takes the LAST block, not the first — a transcript carries the ask and every earlier answer", () => {
    // This is the case that makes a naive regex wrong: the text handed in is an accumulated
    // transcript, so the first match is the ask's own placeholder and the second is a stale answer.
    const transcript =
      BLOCKER_ASK + "\n\n" + reply("blocked-on-ci", "waiting on shard 4") + "\n\n" + reply("not-blocked", "landing it");
    expect(parseBlockerReport(transcript, 1)).toEqual({
      state: "not-blocked",
      detail: "landing it",
      at: 1,
    });
  });

  it("ignores fenced blocks that are not ours", () => {
    const other = "```json\n{\"blocked\": \"blocked-on-human\"}\n```";
    expect(parseBlockerReport(other, 1)).toBeUndefined();
  });

  it("tolerates decoration an agent adds around the word", () => {
    for (const decorated of ["`not-blocked`", "**not-blocked**", '"not-blocked"', "not-blocked."]) {
      expect(parseBlockerReport(reply(decorated), 1)?.state).toBe("not-blocked");
    }
  });

  it("accepts a state with no next line — the state alone is routable", () => {
    expect(parseBlockerReport(reply("blocked-on-quota"), 1)).toEqual({
      state: "blocked-on-quota",
      detail: "",
      at: 1,
    });
  });

  it("reads a block truncated mid-write, because a killed agent still said the useful part", () => {
    const cut = "```" + BLOCKER_FENCE + "\nblocked: blocked-on-ci\nnext: re-running shard 4";
    expect(parseBlockerReport(cut, 1)?.state).toBe("blocked-on-ci");
  });

  it("returns undefined for a word outside the vocabulary rather than guessing the nearest one", () => {
    expect(parseBlockerReport(reply("blocked-on-vibes"), 1)).toBeUndefined();
    expect(parseBlockerReport(reply("blocked"), 1)).toBeUndefined();
  });

  it("returns undefined for a narrative answer — which is what the OLD prompt produced", () => {
    const narrative =
      "Here's where things stand: I've read the failing test and I think the fix is small. " +
      "Want me to do that now?";
    expect(parseBlockerReport(narrative, 1)).toBeUndefined();
  });

  it("never manufactures blocked-on-human from an unparseable answer", () => {
    // Guessing toward the founder is how a watchdog becomes a pager: whatever garbles one reply is
    // usually fleet-wide, so he would be paged once per agent for one bug.
    for (const junk of ["", "```" + BLOCKER_FENCE + "\n\n```", reply("???")]) {
      expect(parseBlockerReport(junk, 1)?.state).not.toBe("blocked-on-human");
    }
  });

  it("isBlockerState narrows exactly the five", () => {
    expect(isBlockerState("not-blocked")).toBe(true);
    expect(isBlockerState("blocked")).toBe(false);
  });
});

describe("routing — who can act", () => {
  it("sends CI and cross-agent findings to the concierge, not to the agent that already looked", () => {
    expect(routeBlocker({ state: "blocked-on-ci", detail: "shard 4 red", at: 1 }, ctx()).target).toBe(
      "concierge",
    );
    expect(
      routeBlocker({ state: "blocked-on-another-agent", detail: "PR #9 holds the file", at: 1 }, ctx())
        .target,
    ).toBe("concierge");
  });

  it("routes ONLY blocked-on-human to the founder", () => {
    const reached = BLOCKER_STATES.filter(
      (state) => routeBlocker({ state, detail: "d", at: 1 }, ctx()).target === "founder",
    );
    expect(reached).toEqual(["blocked-on-human"]);
  });

  it("puts the founder's one question on one line, and says so when the agent did not give one", () => {
    expect(routeBlocker({ state: "blocked-on-human", detail: "approve the schema change", at: 1 }, ctx()).text)
      .toBe("Mount Tells The Truth needs you: approve the schema change");
    expect(routeBlocker({ state: "blocked-on-human", detail: "", at: 1 }, ctx()).text).toMatch(
      /did not say what it needs/,
    );
  });

  it("suppresses quota entirely — nobody is told, because nobody can act", () => {
    const r = routeBlocker({ state: "blocked-on-quota", detail: "resets 3pm", at: 1 }, ctx());
    expect(r).toEqual({ target: "none", reason: "quota-suppressed", text: "" });
  });

  it("pushes the AGENT when it said it was not blocked, quoting the thing it said it would do", () => {
    const r = routeBlocker({ state: "not-blocked", detail: "open the PR", at: 1 }, ctx());
    expect(r.target).toBe("agent");
    expect(r.text).toContain("open the PR");
    expect(r.text).toMatch(/do not reply to this/);
  });
});

describe("routing — the agent that will not move", () => {
  it("escalates to the concierge once an agent has been pushed twice without moving", () => {
    // The founder's rule, and the thing that makes the loop terminate: an agent pushed twice that
    // did not move is no longer an agent problem. Asserts the ESCALATION (the side effect), not
    // that the counter is set.
    const before = routeBlocker({ state: "not-blocked", detail: "land it", at: 1 }, ctx({ unmovedPushes: 1 }));
    expect(before.target).toBe("agent");

    const after = routeBlocker({ state: "not-blocked", detail: "land it", at: 1 }, ctx({ unmovedPushes: 2 }));
    expect(after.target).toBe("concierge");
    expect(after.reason).toBe("pushed-twice-unmoved");
    expect(after.text).toContain("Mount Tells The Truth");
    expect(after.text).toContain("not-blocked");
  });

  it("still does not escalate a quota-walled agent, which has not failed to move but been unable to", () => {
    const r = routeBlocker({ state: "blocked-on-quota", detail: "", at: 1 }, ctx({ unmovedPushes: 9 }));
    expect(r.target).toBe("none");
  });

  it("overrides even blocked-on-human, so a stalled agent cannot page the founder forever", () => {
    const r = routeBlocker({ state: "blocked-on-human", detail: "approve it", at: 1 }, ctx({ unmovedPushes: 2 }));
    expect(r.target).toBe("concierge");
  });

  it("UNMOVED_PUSH_LIMIT is two", () => {
    expect(UNMOVED_PUSH_LIMIT).toBe(2);
  });
});

describe("silence — the agent that cannot answer at all", () => {
  // THE ACCEPTANCE CASE. An agent died on an Anthropic 529 after 21 minutes of good work and sat
  // `errored` all night. Every route above is keyed on an ANSWER, so silence has to be routable too
  // or the hole reappears one layer up.
  it("says nothing while a transient failure still has retries left", () => {
    const r = routeSilence({
      label: "Mount Tells The Truth",
      transient: true,
      retries: 1,
      retryLimit: TRANSIENT_RETRY_LIMIT,
      message: "API Error: 529 Overloaded",
    });
    expect(r).toEqual({ target: "none", reason: "transient-retrying", text: "" });
  });

  it("escalates to the concierge once the retries are spent, quoting what the agent read", () => {
    const r = routeSilence({
      label: "Mount Tells The Truth",
      transient: true,
      retries: TRANSIENT_RETRY_LIMIT,
      retryLimit: TRANSIENT_RETRY_LIMIT,
      message: "API Error: 529 Overloaded",
    });
    expect(r.target).toBe("concierge");
    expect(r.reason).toBe("transient-retries-exhausted");
    expect(r.text).toContain("529 Overloaded");
    expect(r.text).toContain("4 times");
  });

  it("does not wait at all on a failure that is not self-clearing", () => {
    const r = routeSilence({
      label: "A",
      transient: false,
      retries: 0,
      retryLimit: TRANSIENT_RETRY_LIMIT,
      message: "worktree is gone",
    });
    expect(r.target).toBe("concierge");
    expect(r.reason).toBe("errored-not-transient");
  });

  it("never reaches the founder — a dead agent is the concierge's to restart", () => {
    for (const transient of [true, false]) {
      for (const retries of [0, 99]) {
        expect(
          routeSilence({ label: "A", transient, retries, retryLimit: TRANSIENT_RETRY_LIMIT }).target,
        ).not.toBe("founder");
      }
    }
  });
});

describe("classifying a failure as transient", () => {
  it("recognises the 529 this was built for", () => {
    expect(isTransientFailure("API Error: 529 Overloaded")).toBe(true);
    expect(isTransientFailure("overloaded_error")).toBe(true);
  });

  it.each(["502 Bad Gateway", "503", "Gateway Timeout 504", "ECONNRESET", "socket hang up", "rate_limit"])(
    "recognises %s",
    (m) => expect(isTransientFailure(m)).toBe(true),
  );

  it("fails toward escalating: an unrecognised or absent message is NOT transient", () => {
    // The asymmetry is deliberate. A wrong `true` retries an agent into the ground while telling
    // nobody; a wrong `false` costs one early, correct escalation.
    expect(isTransientFailure(undefined)).toBe(false);
    expect(isTransientFailure("")).toBe(false);
    expect(isTransientFailure("You've hit your session limit")).toBe(false);
    expect(isTransientFailure("worktree removed")).toBe(false);
  });
});

describe("backoff", () => {
  it("checks back several times inside the window a 529 actually clears in", () => {
    expect(retryDelayMs(0)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(1)).toBe(4 * RETRY_BASE_MS);
    expect(retryDelayMs(2)).toBe(9 * RETRY_BASE_MS);
  });

  it("is capped, so a long outage does not push the next check past usefulness", () => {
    expect(retryDelayMs(50)).toBe(RETRY_MAX_MS);
    expect(retryDelayMs(500)).toBe(RETRY_MAX_MS);
  });

  it("is monotonic and never zero — a zero delay would be a busy loop against a failing API", () => {
    let prev = 0;
    for (let i = 0; i < 12; i++) {
      const d = retryDelayMs(i);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it("spends under half an hour of patience before somebody hears about it", () => {
    const total = [0, 1, 2, 3].reduce((a, i) => a + retryDelayMs(i), 0);
    expect(total).toBeLessThanOrEqual(30 * 60_000);
    expect(TRANSIENT_RETRY_LIMIT).toBe(4);
  });

  it("treats a negative or fractional attempt as the first one rather than going backwards", () => {
    expect(retryDelayMs(-3)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(0.7)).toBe(RETRY_BASE_MS);
  });
});

describe("the vocabulary is a routing table", () => {
  it("every state routes somewhere, and no two states are the same route with two names", () => {
    // The test for adding a sixth state: if it collides with an existing (target, reason) pair it is
    // one state wearing two names, and the extra name only makes the agent's choice harder.
    const seen = new Map<string, BlockerState>();
    for (const state of BLOCKER_STATES) {
      const r = routeBlocker({ state, detail: "d", at: 1 }, ctx());
      const key = `${r.target}:${r.reason}`;
      expect(seen.has(key), `${state} duplicates ${seen.get(key)}`).toBe(false);
      seen.set(key, state);
    }
    expect(seen.size).toBe(BLOCKER_STATES.length);
  });
});

describe("buildAsk — the ask is a function, and one arm sends nothing", () => {
  // The founder ranked two real exchanges and the lesson is in the ranking: an agent that had
  // already reported done-and-landed was asked for a status update anyway and spent a whole turn
  // saying "same as last check". "The second is not a bad ANSWER; it is a bad QUESTION."

  const done: BlockerReport = { state: "not-blocked", detail: "PR is merged", at: 1 };

  it("ASKS NOTHING when nothing changed and the agent was already finished", () => {
    // THE WASTE CASE. At fleet scale this is the dominant cost of asking, and it is pure waste.
    expect(buildAsk({ previous: done, terminal: true, changes: [], msSinceLastAsk: 1_000 }))
      .toBeUndefined();
  });

  it("still asks a finished-looking agent once something actually moves", () => {
    const ask = buildAsk({
      previous: done,
      terminal: true,
      changes: ["main has moved since you last looked"],
      msSinceLastAsk: 1_000,
    });
    expect(ask).toBeDefined();
    expect(ask).toContain("main has moved since you last looked");
  });

  it("names the blocker instead of re-asking generically when nothing has changed", () => {
    const ask = buildAsk({
      previous: { state: "blocked-on-ci", detail: "shard four is red", at: 1 },
      terminal: false,
      changes: [],
    });
    expect(ask).toContain("blocked-on-ci");
    expect(ask).toContain("shard four is red");
    expect(ask).toContain("STILL blocking you");
    // The generic question is what the founder rejected; it must not be what arrives here.
    expect(ask).not.toContain("What is BLOCKING you from merging");
  });

  it("leads with the change, then asks", () => {
    const ask = buildAsk({
      previous: { state: "blocked-on-ci", detail: "shard four is red", at: 1 },
      terminal: false,
      changes: ["your PR's checks have concluded", "another agent landed in a file you are editing"],
    })!;
    expect(ask.indexOf("checks have concluded")).toBeLessThan(ask.indexOf("BLOCKING you from merging"));
    expect(ask).toContain("another agent landed in a file you are editing");
  });

  it("falls back to the canned ask on first contact, when there is nothing to be specific about", () => {
    expect(buildAsk({ terminal: false, changes: [] })).toBe(BLOCKER_ASK);
  });

  it("does not go silent on an unfinished agent just because nothing changed", () => {
    // Silence is only correct for the TERMINAL case. An agent that is stalled and not finished is
    // exactly the one worth asking, and it is the state this whole loop exists for.
    expect(buildAsk({ terminal: false, changes: [] })).toBeDefined();
    expect(buildAsk({ previous: done, terminal: false, changes: [] })).toBeDefined();
  });

  it("every arm that asks still demands the machine-readable block", () => {
    const asks = [
      buildAsk({ terminal: false, changes: [] }),
      buildAsk({ previous: { state: "blocked-on-ci", detail: "d", at: 1 }, terminal: false, changes: [] }),
      buildAsk({ terminal: false, changes: ["main has moved"] }),
      buildAsk({ previous: done, terminal: true, changes: ["main has moved"] }),
    ];
    for (const ask of asks) {
      expect(ask).toBeDefined();
      expect(ask).toContain("```" + BLOCKER_FENCE);
      for (const state of BLOCKER_STATES) expect(ask).toContain(state);
    }
  });

  it("adds no digits of its own, so a composed ask still survives the citation gate", () => {
    // The caller's obligation is digit-free change strings; this pins that the composition does not
    // introduce any either. A number here would fail the WHOLE challenge and the agent would get
    // nothing, silently, while the trigger burned its cooldown.
    const ask = buildAsk({
      previous: { state: "blocked-on-another-agent", detail: "waiting on the other branch", at: 1 },
      terminal: false,
      changes: ["main has moved since you last looked"],
    })!;
    expect(numbersIn(ask)).toEqual([]);
    expect(checkCitations(`Your goal expired 3h 12m ago.\n\n${ask}`, ["3", "12"]).ok).toBe(true);
  });

  it("ignores blank change lines rather than leading with an empty bullet", () => {
    expect(buildAsk({ previous: done, terminal: true, changes: ["", "   "], msSinceLastAsk: 1_000 }))
      .toBeUndefined();
  });
});

describe("the silence is bounded — a wrong 'terminal' must not be permanent (roborev 57707)", () => {
  const done: BlockerReport = { state: "not-blocked", detail: "PR is merged", at: 1 };

  it("lapses after an hour, because nothing else would ever lift it", () => {
    // `changes` can only carry a sentence when a measurement MOVES, and a wedged agent's
    // measurements never move — so without an expiry, one wrong `terminal` silences that agent for
    // the life of the process. That is the exact failure this loop exists to prevent.
    expect(buildAsk({ previous: done, terminal: true, changes: [], msSinceLastAsk: MAX_SILENCE_MS - 1 }))
      .toBeUndefined();
    expect(buildAsk({ previous: done, terminal: true, changes: [], msSinceLastAsk: MAX_SILENCE_MS }))
      .toBeDefined();
  });

  it("never goes silent on an agent we have never heard from", () => {
    // `terminal` is OUR inference from a latched goal and a clean branch; `previous` is the agent's
    // own report. An agent that died before committing anything — the 529 case — presents exactly
    // that way: met goal, clean branch, dead process. It must still be asked.
    expect(buildAsk({ terminal: true, changes: [], msSinceLastAsk: 1_000 })).toBeDefined();
  });

  it("never goes silent on an agent whose own last word was that it IS blocked", () => {
    for (const state of BLOCKER_STATES.filter((s) => s !== "not-blocked")) {
      expect(
        buildAsk({ previous: { state, detail: "d", at: 1 }, terminal: true, changes: [], msSinceLastAsk: 1 }),
      ).toBeDefined();
    }
  });

  it("never goes silent before it has asked even once", () => {
    expect(buildAsk({ previous: done, terminal: true, changes: [] })).toBeDefined();
  });

  it("never goes silent on a BACKWARDS clock, which would otherwise read as 'asked a moment ago'", () => {
    // The bound re-entered through itself (roborev 57711). Callers compute this as `now - askedAt`,
    // which goes negative on any backwards wall-clock step — an NTP correction after sleep/wake, a
    // VM resume. Compared naively, a large negative number is less than any threshold, so the agent
    // would stay silent until wall time caught back up to a stale stamp: exactly the unbounded
    // silence this field exists to prevent.
    expect(
      buildAsk({ previous: done, terminal: true, changes: [], msSinceLastAsk: -1 }),
    ).toBeDefined();
    expect(
      buildAsk({ previous: done, terminal: true, changes: [], msSinceLastAsk: -1.75e12 }),
    ).toBeDefined();
    // ...and zero is a legitimate reading (asked this same millisecond), so it still suppresses.
    expect(
      buildAsk({ previous: done, terminal: true, changes: [], msSinceLastAsk: 0 }),
    ).toBeUndefined();
  });
});

describe("arm 2 cannot smuggle a number in from the agent's own words (roborev 57707)", () => {
  it("drops the quote when the detail carries digits, keeping the ask gate-safe", () => {
    // `detail` is an unbounded line of the agent's output — "shard 4 is red", "waiting on PR #1104".
    // A number here would fail checkCitations for the WHOLE challenge and the agent would receive
    // nothing at all, silently.
    const ask = buildAsk({
      previous: { state: "blocked-on-ci", detail: "shard 4 is red", at: 1 },
      terminal: false,
      changes: [],
    })!;
    expect(numbersIn(ask)).toEqual([]);
    expect(ask).not.toContain("shard 4 is red");
    // ...but the follow-up is still specific, because the state name survives.
    expect(ask).toContain("blocked-on-ci");
  });

  it("still quotes a digit-free detail, which is the whole value of arm 2", () => {
    const ask = buildAsk({
      previous: { state: "blocked-on-ci", detail: "the lint shard is red", at: 1 },
      terminal: false,
      changes: [],
    })!;
    expect(ask).toContain("the lint shard is red");
  });

  it("drops an essay rather than quoting it back", () => {
    const essay = "x".repeat(MAX_QUOTED_DETAIL + 1);
    expect(buildAsk({ previous: { state: "blocked-on-ci", detail: essay, at: 1 }, terminal: false, changes: [] }))
      .not.toContain(essay);
  });

  it("every arm survives the real citation gate, including the one that quotes", () => {
    for (const detail of ["shard 4 is red", "waiting on PR #1104", "CI run 12345", "the lint shard"]) {
      const ask = buildAsk({
        previous: { state: "blocked-on-ci", detail, at: 1 },
        terminal: false,
        changes: [],
      })!;
      expect(checkCitations(`Your goal expired 3h 12m ago.\n\n${ask}`, ["3", "12"]).ok).toBe(true);
    }
  });
});

describe("an account limit is a WALL, not silence (roborev 57773)", () => {
  const walled = () =>
    routeAccountLimit({ label: "Mount Tells The Truth", message: "resets at 3pm" });

  it("does not claim the agent is dead — a terminal limit escalates BEFORE the liveness gates", () => {
    // decideRevive answers failure === "terminal" before the canAcceptInput / processAlive checks,
    // so a walled agent is typically RUNNING and accepting input. It simply cannot make progress.
    expect(walled().text).not.toContain("is not running");
    expect(walled().text).toContain("is running but blocked on an account limit");
  });

  it("tells the concierge NOT to restart it, which is the whole point", () => {
    // Restarting an agent whose session window has not reset just re-fails. routeSilence ends with
    // "restart it or take its branch over", so a concierge following that instruction did the exact
    // thing the fix existed to prevent.
    expect(walled().text).toContain("DO NOT restart it");
    expect(walled().text).not.toMatch(/Restart it or take its branch over/);
  });

  it("quotes the banner verbatim — the only place the reset time and remedy path appear", () => {
    expect(walled().text).toContain("resets at 3pm");
    expect(routeAccountLimit({ label: "A" }).text).not.toContain("undefined");
  });

  it("goes to the concierge, never the founder — a clock-based limit is not a page", () => {
    expect(walled().target).toBe("concierge");
    expect(walled().reason).toBe("account-limited");
  });

  it("is a DIFFERENT route from silence, not a reworded one", () => {
    const silent = routeSilence({ label: "A", transient: false, retries: 0, retryLimit: 4 });
    expect(routeAccountLimit({ label: "A" }).reason).not.toBe(silent.reason);
  });
});
