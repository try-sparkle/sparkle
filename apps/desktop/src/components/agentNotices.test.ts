// The notice model's own contract. The RENDERING contract — "a row shows a glyph and never the
// words, and the agent's name survives" — is pinned separately, next to the row that has to obey it
// (AgentSidebar.rowNotices.test.tsx). This file pins the producer those renderers share.
import { describe, expect, it } from "vitest";

import {
  agentNotices,
  GOAL_STALL_ALIAS,
  NOTICE_EXPLAINER,
  resolveNoticeId,
  rowGlyphsFor,
  type AgentNotice,
} from "./agentNotices";
import type { GoalBadge } from "./rowAttention";
import { STALL_CAUSE_LABEL, THRASH_VERDICT_LABEL } from "./rowAttention";
import type { StallCause, StallReport } from "../engine/agentStall";
import type { ThrashReport, ThrashVerdict } from "../engine/agentThrash";

function thrashOf(verdict: ThrashReport["verdict"], detail = "d"): ThrashReport {
  return {
    verdict,
    thrashing: verdict !== "healthy",
    turnsWithoutTool: 0,
    recentCompactions: 0,
    detail,
  };
}

function stallOf(causes: StallReport["causes"], detail = "s"): StallReport {
  return { verdict: causes.length > 0 ? "stalled" : "finished", causes, detail };
}

function goalOf(state: GoalBadge["state"], text = "land the retry PR"): GoalBadge {
  return { state, text, label: state, escalated: state === "escalated" };
}

/** Every goal state, so a state added later cannot slip past these cases untested. */
const GOAL_STATES: GoalBadge["state"][] = ["unmet", "met", "expired", "escalated"];

describe("agentNotices", () => {
  it("says nothing about an agent nobody has looked at", () => {
    // The `undefined`-is-a-value discipline: no inputs must produce no notices, NEVER a reassuring
    // one. A row we failed to read is not a row to make a claim about.
    expect(agentNotices({})).toEqual([]);
  });

  it("does not turn a healthy thrash report into a notice", () => {
    expect(agentNotices({ thrash: thrashOf("healthy") })).toEqual([]);
  });

  it("carries the engine's own wording, never a second copy of it", () => {
    // The labels come from rowAttention's tables. If someone re-spells "Rate limited" here, this
    // fails — which is the drift engine/workerRollup.ts warns about twice.
    const [n] = agentNotices({ thrash: thrashOf("quota-blocked", "hit the 5-hour limit") });
    expect(n).toMatchObject({
      id: "thrash:quota-blocked",
      cls: "warning",
      glyph: "alert",
      label: "Rate limited",
      detail: "hit the 5-hour limit",
    });
  });

  it("gives EVERY stall cause a notice, not just the head with a +N", () => {
    // The row could only show one phrase, so it showed the first cause and hung "+2" off it. The
    // composer has room for all of them, and "+2" is precisely the reading the founder cannot act
    // on. Ordered worst-first regardless of the order the engine listed them in.
    const notices = agentNotices({
      stall: stallOf(["uncommitted-changes", "escalated-goal", "open-pr"]),
    });
    expect(notices.map((n) => n.id)).toEqual([
      "stall:escalated-goal",
      "stall:open-pr",
      "stall:uncommitted-changes",
    ]);
  });

  it("marks an escalated goal with its own glyph, not the ordinary alert", () => {
    // Auto-continue has given up: nothing is coming for this agent at all. A reader scanning forty
    // rows must be able to tell that from an agent that merely owes a merge.
    const notices = agentNotices({ stall: stallOf(["escalated-goal"]) });
    expect(notices[0]?.glyph).toBe("escalated");
  });

  it("does not raise stall notices for a report that is not stalled", () => {
    expect(agentNotices({ stall: { verdict: "unknown", causes: [], detail: "" } })).toEqual([]);
    expect(agentNotices({ stall: { verdict: "finished", causes: [], detail: "" } })).toEqual([]);
  });

  it("counts pending inbox messages and puts them LAST", () => {
    // A queued instruction is the system working as designed. It must not lead a row on which
    // something is actually wrong.
    const notices = agentNotices({ thrash: thrashOf("repeating-command"), pendingInbox: 2 });
    expect(notices.map((n) => n.id)).toEqual(["thrash:repeating-command", "inbox"]);
    expect(notices[1]).toMatchObject({
      cls: "message",
      glyph: "inbox",
      label: "2 queued messages",
    });
  });

  it("singularizes one queued message", () => {
    expect(agentNotices({ pendingInbox: 1 })[0]?.label).toBe("1 queued message");
  });

  it("treats an empty inbox as nothing to say", () => {
    expect(agentNotices({ pendingInbox: 0 })).toEqual([]);
  });
});

describe("rowGlyphsFor", () => {
  it("gives a quiet agent no marks at all", () => {
    // The half of the column that was never broken must keep rendering exactly as it did.
    expect(rowGlyphsFor([])).toEqual([]);
  });

  it("COLLAPSES a class to ONE mark — four warnings are not four exclamation points", () => {
    // This is the founder's actual complaint ("I can't read all of these in line notices"). A mark
    // per notice would rebuild the same wall of signal in icon form.
    const notices = agentNotices({
      thrash: thrashOf("quota-blocked"),
      stall: stallOf(["open-pr", "uncommitted-changes", "unmet-goal"]),
    });
    expect(notices).toHaveLength(4);
    const marks = rowGlyphsFor(notices);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ cls: "warning", count: 4 });
  });

  it("keeps warnings and messages as separate marks, warnings first", () => {
    const marks = rowGlyphsFor(
      agentNotices({ thrash: thrashOf("no-progress"), pendingInbox: 3 }),
    );
    expect(marks.map((m) => m.cls)).toEqual(["warning", "message"]);
    expect(marks[1]?.count).toBe(1);
  });

  it("takes the LOUDEST glyph in a class, whatever order the notices arrive in", () => {
    // An escalated goal must not hide behind a milder sibling that happened to sort first.
    const mild: AgentNotice = {
      id: "stall:open-pr",
      cls: "warning",
      glyph: "alert",
      label: "PR unmerged",
    };
    const loud: AgentNotice = {
      id: "stall:escalated-goal",
      cls: "warning",
      glyph: "escalated",
      label: "auto-continue gave up",
    };
    expect(rowGlyphsFor([mild, loud])[0]?.glyph).toBe("escalated");
    expect(rowGlyphsFor([loud, mild])[0]?.glyph).toBe("escalated");
  });

  it("puts every label in the hover, which is the no-mount reading path", () => {
    // "Hover or click the row icon reveals the same detail WITHOUT mounting" — so the mark's title
    // has to carry the words the row itself is forbidden to render.
    const mark = rowGlyphsFor(
      agentNotices({ thrash: thrashOf("context-pressure"), stall: stallOf(["open-pr"]) }),
    )[0];
    expect(mark?.title).toContain("Context exhausted");
    expect(mark?.title).toContain("PR unmerged");
    expect(mark?.ariaLabel).toBe("2 warnings: Context exhausted, PR unmerged");
  });

  it("names a single warning in the singular", () => {
    expect(rowGlyphsFor(agentNotices({ stall: stallOf(["open-pr"]) }))[0]?.ariaLabel).toBe(
      "1 warning: PR unmerged",
    );
  });

  it("does not STUTTER when the class phrase already names the members", () => {
    // roborev 58710/58721. The inbox notice's own label is "3 queued messages", which is
    // character-for-character what the message class's a11y phrase says — so the naive
    // `${phrase}: ${labels}` announced "3 queued messages: 3 queued messages" to the one reader who
    // has no other channel, these marks having no visible text by construction. Both counts,
    // because singular and plural are separate strings and only one of them was ever read aloud in
    // review. FAILS against the un-deduped form at BOTH.
    const one = rowGlyphsFor(agentNotices({ pendingInbox: 1 }))[0];
    expect(one?.ariaLabel).toBe("1 queued message");
    const many = rowGlyphsFor(agentNotices({ pendingInbox: 3 }))[0];
    expect(many?.ariaLabel).toBe("3 queued messages");
  });

  it("names the LOUDEST notice as the mark's lead, so a click knows which pill to open", () => {
    // The founder's worked example: clicking the mailbox on the row expands the queued-messages
    // pill above the composer. Without a lead id the click could only say "something in this
    // class" and the composer would have to guess.
    const marks = rowGlyphsFor(
      agentNotices({
        thrash: thrashOf("quota-blocked"),
        stall: stallOf(["escalated-goal", "open-pr"]),
        pendingInbox: 2,
      }),
    );
    const warning = marks.find((m) => m.cls === "warning");
    const message = marks.find((m) => m.cls === "message");
    // escalated-goal is the only `escalated` glyph in the class, so it leads regardless of the
    // fact that the thrash notice was produced first.
    expect(warning?.leadNoticeId).toBe("stall:escalated-goal");
    expect(message?.leadNoticeId).toBe("inbox");
  });

  it("leads with the worst notice when every warning shares one glyph", () => {
    // All `alert`, so the glyph cannot break the tie — the ordering `agentNotices` already applied
    // has to. Thrash (burning time now) outranks a stall cause (work merely owing).
    const mark = rowGlyphsFor(
      agentNotices({ thrash: thrashOf("no-progress"), stall: stallOf(["open-pr"]) }),
    )[0];
    expect(mark?.leadNoticeId).toBe("thrash:no-progress");
  });
});

describe("the GOAL notices — the blue target and the red octagon", () => {
  // The founder's second scope addition (bead sparkle-tyter): he clicked these marks, got silence,
  // and could not find out what they meant. The pill is where the meaning lives, so it has to exist.
  it.each(GOAL_STATES)("emits a pill for the %s goal, carrying the goal's own words", (state) => {
    const [n] = agentNotices({ goal: goalOf(state) });
    expect(n?.id).toBe(`goal:${state}`);
    expect(n?.cls).toBe("goal");
    // The state's own words are the DETAIL — no explainer can supply "land the retry PR", and it is
    // the thing that makes the pill about THIS agent rather than about the feature in general.
    expect(n?.detail).toBe("land the retry PR");
    expect(n?.label.length).toBeGreaterThan(0);
  });

  it.each(GOAL_STATES)("explains the %s goal in plain English", (state) => {
    const text = NOTICE_EXPLAINER[`goal:${state}`];
    expect(text, `no NOTICE_EXPLAINER entry for "goal:${state}"`).toBeTruthy();
    expect(text!.length).toBeGreaterThan(60);
  });

  it("says 'auto-continue gave up' rather than the word he could not act on", () => {
    // "Escalated" is the token the engine uses; it is not what it MEANS to the person reading it.
    const [n] = agentNotices({ goal: goalOf("escalated") });
    expect(n?.label).toBe("Auto-continue gave up");
    expect(n?.label.toLowerCase()).not.toContain("escalat");
  });

  it("does not say the same fact twice when the STALL already said it", () => {
    // A stalled agent carrying an unmet goal gets `stall:unmet-goal` from the engine AND would get
    // `goal:unmet` here — one fact, two vocabularies, two pills. The stall wording wins.
    const ids = agentNotices({
      stall: stallOf(["unmet-goal"]),
      goal: goalOf("unmet"),
    }).map((n) => n.id);
    expect(ids).toContain("stall:unmet-goal");
    expect(ids).not.toContain("goal:unmet");
  });

  it("still emits the goal pill when the stall is about something ELSE", () => {
    // The control for the suppression above: without it, dropping the goal notice entirely would
    // pass. An open PR is not a statement about the goal, so both belong.
    const ids = agentNotices({ stall: stallOf(["open-pr"]), goal: goalOf("unmet") }).map((n) => n.id);
    expect(ids).toContain("stall:open-pr");
    expect(ids).toContain("goal:unmet");
  });

  it("never suppresses a MET goal — nothing outstanding can pre-empt it", () => {
    // `met` has no stall cause at all, which the alias states by OMITTING it (roborev 59236) rather
    // than by pointing it at a cause behind a guard.
    expect(GOAL_STALL_ALIAS.met).toBeUndefined();
    const ids = agentNotices({ stall: stallOf(["escalated-goal"]), goal: goalOf("met") }).map(
      (n) => n.id,
    );
    expect(ids).toContain("goal:met");
  });

  it("puts the goal AFTER the warnings and BEFORE the messages", () => {
    const ids = agentNotices({
      thrash: thrashOf("quota-blocked"),
      goal: goalOf("met"),
      pendingInbox: 1,
    }).map((n) => n.id);
    expect(ids).toEqual(["thrash:quota-blocked", "goal:met", "inbox"]);
  });
});

describe("the pill that stands in for a goal keeps the goal's MARK and WORDS", () => {
  // roborev 59253. Suppressing `goal:<state>` in favour of the stall cause is right — one fact, one
  // pill — but it was throwing away the two things that made the pill answer the founder's click:
  // the glyph he actually clicked, and his own goal's words.
  it("wears the GOAL's glyph, not a generic amber warning triangle", () => {
    // A blue target click resolving onto an amber alert triangle is not the mark he clicked.
    // FAILS against the unconditional `cause === "escalated-goal" ? "escalated" : "alert"`.
    const [n] = agentNotices({ stall: stallOf(["unmet-goal"]), goal: goalOf("unmet") });
    expect(n?.id).toBe("stall:unmet-goal");
    expect(n?.glyph).toBe("target");
  });

  it("wears the CLOCK for an expired goal, for the same reason", () => {
    const [n] = agentNotices({ stall: stallOf(["expired-goal"]), goal: goalOf("expired") });
    expect(n?.glyph).toBe("clock");
  });

  it("keeps the ordinary alert when the cause is NOT about the goal", () => {
    // The control: without it, always taking the goal glyph would pass the two above.
    const [n] = agentNotices({ stall: stallOf(["open-pr"]), goal: goalOf("unmet") });
    expect(n?.id).toBe("stall:open-pr");
    expect(n?.glyph).toBe("alert");
  });

  it("carries the goal's OWN WORDS, which no explainer can supply", () => {
    // "land the retry PR" is the only part of that pill that is about THIS agent.
    //
    // A DISTINCTIVE SENTINEL for the engine half, not a stray letter (roborev 59278). This asserted
    // `toContain("s")`, which only had force because `stallOf`'s default detail is the literal "s"
    // AND the default goal text happens to contain no lowercase s — two incidental facts. Changing
    // the goal text to anything with an "s" in it would have made the guard vacuous forever while
    // still passing, even if the engine sentence were dropped from the concatenation entirely.
    const [n] = agentNotices({
      stall: stallOf(["escalated-goal"], "ENGINE-SENTENCE"),
      goal: goalOf("escalated"),
    });
    expect(n?.detail).toContain("land the retry PR");
    expect(n?.detail).toContain("ENGINE-SENTENCE");
  });

  it("draws the SAME glyph on the row mark as on the pill for one notice", () => {
    // ══ THE PARITY BUG, RELOCATED AND THEN FIXED (roborev 59278) ══════════════════════════════
    // Giving a goal-derived stall pill the goal's glyph fixed the goal-chip click path and broke the
    // warning-mark path: the row passed no `goal`, so it computed `alert` (amber triangle) for
    // `stall:unmet-goal` while the composer, which does pass it, drew `target` (blue) for that very
    // same notice id. Clicking an amber triangle landed on a blue target pill.
    //
    // Asserted as the two surfaces AGREEING, rather than as either one's literal value, so neither
    // can drift from the other. FAILS if the row stops passing the goal.
    const inputs = { stall: stallOf(["unmet-goal"]), goal: goalOf("unmet") } as const;
    const pill = agentNotices(inputs).find((n) => n.id === "stall:unmet-goal");
    const mark = rowGlyphsFor(agentNotices(inputs)).find((m) => m.cls === "warning");
    expect(mark?.leadNoticeId).toBe("stall:unmet-goal");
    expect(mark?.glyph).toBe(pill?.glyph);
  });

  it("still draws NO row mark for the goal class — the goal chip is that mark", () => {
    // The row passes the goal as an INPUT but must not render a second mark for it.
    const marks = rowGlyphsFor(agentNotices({ goal: goalOf("met") }));
    expect(marks).toEqual([]);
  });

  it("does not staple a goal onto a stall cause that has nothing to do with it", () => {
    const [n] = agentNotices({ stall: stallOf(["open-pr"]), goal: goalOf("unmet") });
    expect(n?.detail).not.toContain("land the retry PR");
  });
});

describe("resolveNoticeId — a click must land on a pill that EXISTS", () => {
  // ══ THE HIGH THIS PINS (roborev 59236) ══════════════════════════════════════════════════════
  // The row's goal chip asks for `goal:<state>`. `agentNotices` suppresses exactly that pill
  // whenever the matching stall cause is present — which is EVERY resting goal-bearing row,
  // including the escalated one the founder photographed, since an escalated agent is by definition
  // idle. A literal id match therefore found nothing, the composer did nothing, and the click was
  // silent: the bug the feature exists to fix, alive inside its own fix. It only appeared to work on
  // a `working` agent, which was the one case the first test seeded.
  it("follows a suppressed goal id to the stall pill that replaced it", () => {
    const notices = agentNotices({ stall: stallOf(["escalated-goal"]), goal: goalOf("escalated") });
    expect(notices.map((n) => n.id)).not.toContain("goal:escalated");
    expect(resolveNoticeId("goal:escalated", notices)).toBe("stall:escalated-goal");
  });

  it.each(Object.entries(GOAL_STALL_ALIAS))(
    "resolves goal:%s when the stall says %s instead",
    (state, cause) => {
      const notices = agentNotices({
        stall: stallOf([cause as StallCause]),
        goal: goalOf(state as GoalBadge["state"]),
      });
      expect(resolveNoticeId(`goal:${state}`, notices)).toBe(`stall:${cause}`);
    },
  );

  it("returns the id unchanged when that pill is right there", () => {
    const notices = agentNotices({ goal: goalOf("unmet") });
    expect(resolveNoticeId("goal:unmet", notices)).toBe("goal:unmet");
  });

  it("resolves the OTHER way too, so a stall-named request reaches a surviving goal pill", () => {
    const notices = agentNotices({ goal: goalOf("unmet") });
    expect(resolveNoticeId("stall:unmet-goal", notices)).toBe("goal:unmet");
  });

  it("returns null when nothing carries the fact, rather than inventing a pill", () => {
    expect(resolveNoticeId("goal:unmet", agentNotices({ thrash: thrashOf("no-progress") }))).toBeNull();
    expect(resolveNoticeId(null, [])).toBeNull();
  });
});

describe("NOTICE_EXPLAINER", () => {
  // The founder: "I don't really understand what rate limited means or what Looping means so
  // there's no reason to tell me if you're not gonna [...] explain it to me in some place, or let
  // me do something about it." A verdict added later with no explanation re-creates exactly that,
  // and nothing else in the suite would notice — so this walks the typed-exhaustive label tables.
  const thrashIds = (Object.keys(THRASH_VERDICT_LABEL) as Exclude<ThrashVerdict, "healthy">[]).map(
    (v) => `thrash:${v}`,
  );
  const stallIds = (Object.keys(STALL_CAUSE_LABEL) as StallCause[]).map((c) => `stall:${c}`);

  it.each([...thrashIds, ...stallIds, "inbox"])("explains %s in plain English", (id) => {
    const text = NOTICE_EXPLAINER[id];
    expect(text, `no NOTICE_EXPLAINER entry for "${id}"`).toBeTruthy();
    // Long enough to actually be an explanation rather than a restated label.
    expect(text!.length).toBeGreaterThan(60);
  });

  it("never promises the quota-blocked agent picks ITSELF back up", () => {
    // roborev 58721, and it is a safety rule rather than a wording preference: the only auto-resume
    // path (`goalContinuation.decideContinuation`) bails with `{action:"none"}` unless the agent has
    // an outstanding goal auto-continue is still driving, so the common no-goal case sits idle until
    // a human nudges it — the incident `engine/quotaBlock.ts`'s header exists to record. Copy that
    // says "nothing needs doing" tells the reader to do exactly the wrong thing.
    const text = NOTICE_EXPLAINER["thrash:quota-blocked"]!;
    expect(text).not.toMatch(/nothing needs doing/i);
    expect(text).not.toMatch(/resumes on its own/i);
    // …and it says what IS true: the resume is conditional on an outstanding goal.
    expect(text).toMatch(/goal/i);
  });

  it("does not merely repeat the label it is explaining", () => {
    // "Looping: looping" would pass a length check and teach nothing.
    for (const [verdict, label] of Object.entries(THRASH_VERDICT_LABEL)) {
      const text = NOTICE_EXPLAINER[`thrash:${verdict}`]!;
      expect(text.toLowerCase().startsWith(label.toLowerCase())).toBe(false);
    }
  });
});
