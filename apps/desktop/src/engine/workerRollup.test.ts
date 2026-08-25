// An orchestrator's dot summarizes its WORKERS, so a folded row still tells the truth.
//
// The column collapses subtrees by default, which means the row you see is usually a head standing
// in for work you can't see. Painting that head from its own PTY status made it lie in the case
// that matters: an orchestrator sitting quietly in `idle` while three of its workers are blocked on
// a question renders GRAY — "nothing to do here" — and the fold hides the only rows that disagree.
//
// The law, stated once: GREY IS IGNORED; RED AND GREEN TOGETHER MAKE ORANGE. Everything below is
// that sentence plus the one exception, own-red-wins.
import { describe, expect, it } from "vitest";
import {
  bandOfRollup,
  rollupDot,
  rollupDotAccessor,
  withWorkerRollupGreen,
} from "./workerRollup";
// The peek lives in a DIFFERENT module on purpose, and importing it here is deliberate rather than
// sloppy: the law this file's last block pins is a coupling BETWEEN the two, and a coupling asserted
// on only one side of itself is not asserted at all. See that block for the full story.
import { attentionWorkersOf } from "./workerExpansion";
import type { AgentTabStatus } from "../types";

/** A worker set built from statuses; the helper exists so each case reads as its truth-table row. */
const w = (...statuses: AgentTabStatus[]) => statuses;

describe("rollupDot — the six stated cases", () => {
  it("all green → green", () => {
    expect(rollupDot("idle", w("working", "working"))).toBe("green");
  });

  it("all red → red", () => {
    expect(rollupDot("idle", w("waiting", "errored"))).toBe("red");
  });

  it("all grey → grey", () => {
    expect(rollupDot("idle", w("idle", "done", "stopped"))).toBe("gray");
  });

  it("green + red → orange", () => {
    expect(rollupDot("idle", w("working", "waiting"))).toBe("orange");
  });

  it("green + grey → green", () => {
    expect(rollupDot("idle", w("working", "done"))).toBe("green");
  });

  it("red + grey → red", () => {
    expect(rollupDot("idle", w("waiting", "done"))).toBe("red");
  });
});

describe("rollupDot — the case that follows from the law rather than being stated", () => {
  // Grey is ignored, so a three-way mix is just the green+red case with noise in it.
  it("green + red + grey → orange", () => {
    expect(rollupDot("idle", w("working", "blocked", "stopped"))).toBe("orange");
  });
});

describe("rollupDot — an orchestrator's OWN red wins outright", () => {
  // The orchestrator is asking YOU something. Healthy workers must not be able to paint over that:
  // the whole point of the rollup is that a folded row can't hide a question, and the question the
  // head itself is asking is the one you are most directly blocking.
  it("beats a full set of green workers", () => {
    expect(rollupDot("waiting", w("working", "working", "working"))).toBe("red");
  });

  it("beats a mix that would otherwise be orange", () => {
    expect(rollupDot("approval", w("working", "waiting"))).toBe("red");
  });

  // …but own GREEN does not win: an orchestrator busy delegating while every worker under it is
  // blocked is not a healthy row, and "all red → red" is stated flatly.
  it("does not apply in reverse — a working head with all-red workers is red", () => {
    expect(rollupDot("working", w("waiting", "blocked"))).toBe("red");
  });

  it("does not apply in reverse for a mix either", () => {
    expect(rollupDot("working", w("working", "errored"))).toBe("orange");
  });
});

describe("rollupDot — a childless row is just itself", () => {
  it("maps a working head to green", () => {
    expect(rollupDot("working", w())).toBe("green");
  });

  it("maps a red head to red", () => {
    expect(rollupDot("blocked", w())).toBe("red");
  });

  it("maps a calm head to gray", () => {
    expect(rollupDot("idle", w())).toBe("gray");
  });

  // A row's OWN `unmerged` stays GRAY (tokens.ts: it is a LANDING state, not an alarm — it was red
  // until 2026-07-26, when 27 of 51 agents sat in that band and made red meaningless). The rollup
  // inherits that judgement for the row's own status and does not re-escalate it.
  //
  // ⚠️ THIS COMMENT USED TO SAY "a CHILD's `unmerged` now escalates — see the 'a child that owes a
  // merge' block at the bottom". BOTH HALVES WERE FALSE. That escalation shipped and was reverted
  // the same day (c7bd3e50c, "satisfy the never-hide rule with the peek, not the rollup dot") and
  // its block went with it, so the pointer dangled at nothing while asserting the opposite of the
  // law. A child's `unmerged` does NOT escalate this dot, and that is the DECISION — see the
  // "gray dot is licensed BY the peek" block at the bottom, which now pins it.
  it("keeps a row's OWN `unmerged` calm", () => {
    expect(rollupDot("unmerged", w())).toBe("gray");
    expect(rollupDot("unmerged", w("idle", "done"))).toBe("gray");
  });
});

describe("bandOfRollup — which filter chip finds this row", () => {
  // Orange has no AGENT_STATUS entry (that enum's three color tiers are pinned 1:1 to the three
  // bands), so the mapping from a rollup color to a band is stated here rather than derived.
  it("files red and orange under Needs you", () => {
    expect(bandOfRollup("red")).toBe("needs_you");
    expect(bandOfRollup("orange")).toBe("needs_you");
  });

  it("files green under Running and gray under Done", () => {
    expect(bandOfRollup("green")).toBe("running");
    expect(bandOfRollup("gray")).toBe("done");
  });
});

// ── The two rules the rollup inherits from the overlay it replaces ────────────────────────────
//
// `withRedWorkerAttention` is the pre-existing "bubble a red worker onto its orchestrator" pass.
// The rollup does that job better (it can tell all-red from some-red), but it has to carry the two
// exceptions that overlay learned the hard way, or it silently re-opens the bugs they closed.
describe("rollupDotAccessor — dismissal beats the rollup", () => {
  const agents = [
    { id: "p1", kind: "build", parentId: null },
    { id: "w1", kind: "worker", parentId: "p1" },
  ];
  const statuses = (m: Record<string, AgentTabStatus>) => (id: string) => m[id] ?? "stopped";

  // THE case "Dismiss Alert" is used in. Without this the dismissal had no visible effect at all:
  // the head's own status went calm, and then the rollup read the worker's still-red status and
  // repainted the row red, re-filing it under "Needs you".
  it("calms a head whose bubbled red the user dismissed", () => {
    const dotOf = rollupDotAccessor(agents, statuses({ p1: "idle", w1: "blocked" }), undefined, {
      isDismissed: (id) => id === "p1",
    });
    expect(dotOf("p1")).toBe("gray");
  });

  // DISMISSING AN ORANGE HEAD LEAVES IT GREEN, NOT GRAY — and this test asserted gray for one
  // commit, which was the bug rather than the contract. Dismissal silences an ALARM; it does not
  // mean "nothing is happening here". Collapsing the whole rollup dropped the still-running worker
  // along with the dismissed red, so a folded subtree with live work in it read "nothing to do" —
  // the exact lie this module exists to remove — and with the Done chip off, that head and its
  // running subtree vanished from the column. The reds are dropped and the rest is re-rolled.
  it("degrades a dismissed ORANGE head to green, keeping the live worker visible", () => {
    const dotOf = rollupDotAccessor(
      agents.concat({ id: "w2", kind: "worker", parentId: "p1" }),
      statuses({ p1: "idle", w1: "waiting", w2: "working" }),
      undefined,
      { isDismissed: (id) => id === "p1" },
    );
    expect(dotOf("p1")).toBe("green");
  });

  it("still goes fully calm when the dismissed head has nothing else running", () => {
    const dotOf = rollupDotAccessor(
      agents.concat({ id: "w2", kind: "worker", parentId: "p1" }),
      statuses({ p1: "idle", w1: "waiting", w2: "done" }),
      undefined,
      { isDismissed: (id) => id === "p1" },
    );
    expect(dotOf("p1")).toBe("gray");
  });

  // Dismissal is about REDS. Silencing a green rollup would hide live work, which no dismissal ever
  // asked for.
  it("leaves a green rollup alone", () => {
    const dotOf = rollupDotAccessor(agents, statuses({ p1: "idle", w1: "working" }), undefined, {
      isDismissed: () => true,
    });
    expect(dotOf("p1")).toBe("green");
  });

  it("does nothing when the head is not dismissed", () => {
    const dotOf = rollupDotAccessor(agents, statuses({ p1: "idle", w1: "blocked" }));
    expect(dotOf("p1")).toBe("red");
  });
});

describe("rollupDotAccessor — in-motion suppression, mirroring withRedWorkerAttention", () => {
  const agents = [
    { id: "p1", kind: "build", parentId: null },
    { id: "w1", kind: "worker", parentId: "p1" },
    { id: "w2", kind: "worker", parentId: "p1" },
  ];
  const statuses = (m: Record<string, AgentTabStatus>) => (id: string) => m[id] ?? "stopped";

  // `blocked` is red but is NOT asking you anything. On a parent that is visibly progressing the
  // overlay deliberately swallows it; the rollup counting it anyway painted a working orchestrator
  // red and floated it into "Needs you" while you watched it produce output.
  it("swallows a BLOCKED worker under a parent in motion", () => {
    const dotOf = rollupDotAccessor(
      agents,
      statuses({ p1: "working", w1: "blocked", w2: "working" }),
      undefined,
      { isInMotion: () => true },
    );
    expect(dotOf("p1")).toBe("green");
  });

  // A worker that genuinely needs you now always gets through, however busy its parent is.
  it("never swallows a worker that is actually asking", () => {
    for (const ask of ["waiting", "approval", "errored"] as const) {
      const dotOf = rollupDotAccessor(
        agents,
        statuses({ p1: "working", w1: ask, w2: "working" }),
        undefined,
        { isInMotion: () => true },
      );
      expect(dotOf("p1"), `${ask} must reach the head`).toBe("orange");
    }
  });

  it("still surfaces a blocked worker when the parent is NOT in motion", () => {
    const dotOf = rollupDotAccessor(agents, statuses({ p1: "idle", w1: "blocked" }), undefined, {
      isInMotion: () => false,
    });
    expect(dotOf("p1")).toBe("red");
  });
});

// ── The column and the shared status map must agree ───────────────────────────────────────────
//
// services/conciergeFeed's header states that the sidebar and the feed band on the SAME map. The
// rollup broke that for one tier: the Build column painted an `idle` head with a `working` worker
// GREEN while publishedStatusFor still called it calm, so the TopBar dots and the concierge digest
// disagreed with the column about the same fleet. `withWorkerRollupGreen` is the step that closes
// it, and these pin both halves — that it closes the gap, and that it does not overreach.
describe("withWorkerRollupGreen — one truth for every surface", () => {
  const agents = [
    { id: "p1", kind: "build", parentId: null },
    { id: "w1", kind: "worker", parentId: "p1" },
    { id: "solo", kind: "build", parentId: null },
  ];
  const green = () => "green" as const;

  it("promotes a calm head whose workers roll up green", () => {
    const out = withWorkerRollupGreen(agents, { p1: "idle", w1: "working", solo: "idle" }, green);
    expect(out.p1).toBe("working");
  });

  it("leaves the workers themselves alone — only heads stand in for hidden rows", () => {
    const out = withWorkerRollupGreen(agents, { p1: "idle", w1: "idle", solo: "idle" }, green);
    expect(out.w1).toBe("idle");
  });

  // PROMOTION ONLY. This runs last in the published chain, so a demotion here could quietly undo a
  // red that four earlier overlays worked to establish — including a worker's bubbled alarm.
  it("never demotes a red head, whatever the rollup says", () => {
    const out = withWorkerRollupGreen(
      agents,
      { p1: "waiting", w1: "working", solo: "errored" },
      green,
    );
    expect(out.p1).toBe("waiting");
    expect(out.solo).toBe("errored");
  });

  // THE SECOND LOCK, which nothing in this file pinned before: `withWorkerRollupGreen` skips a head
  // whose current status is `unmerged`, and deleting that skip left the whole suite green (the
  // rollupDot side is the FIRST lock, and it is tested through `rollupDot` directly — but this
  // function is what WRITES into the shared status map, so losing `unmerged` here costs the "Needs
  // merge" label, conciergeRecap's classification and isCalmBand all at once). A caller passing its
  // own `dotOf` reaches this arm without going through rollupDot at all, which is exactly how a
  // regression would arrive.
  it("never promotes an `unmerged` head, even when handed a green dot", () => {
    const out = withWorkerRollupGreen(agents, { p1: "unmerged", w1: "working", solo: "idle" }, green);
    expect(out.p1).toBe("unmerged");
  });

  it("does not touch a head whose rollup is not green", () => {
    const out = withWorkerRollupGreen(agents, { p1: "idle", w1: "idle", solo: "idle" }, () => "gray");
    expect(out.p1).toBe("idle");
  });

  // Referential identity matters: this sits in a map consumed by React state, and a fresh object
  // every frame would re-render every consumer for nothing.
  it("returns the same reference when nothing is promoted", () => {
    const input = { p1: "working", w1: "working", solo: "idle" } as const;
    expect(withWorkerRollupGreen(agents, input, () => "gray")).toBe(input);
  });
});

describe("rollupDot — green does NOT override `unmerged`", () => {
  // The column side of the headline fix. Asserted here as well as through publishedStatusFor,
  // because the published assertion passes on the SECOND lock alone (withWorkerRollupGreen's
  // `current === "unmerged"` skip) — reverting this rule would leave the whole suite green while
  // the column painted the head green and every other surface banded it `done`.
  it("keeps an unmerged head gray even with a running worker", () => {
    expect(rollupDot("unmerged", w("working"))).toBe("gray");
    expect(rollupDot("unmerged", w("working", "working"))).toBe("gray");
  });

  // Reds still get through: `unmerged` outranks the GREEN promotion, not a worker that needs you.
  it("still surfaces a red worker under an unmerged head", () => {
    expect(rollupDot("unmerged", w("waiting"))).toBe("red");
    expect(rollupDot("unmerged", w("working", "waiting"))).toBe("orange");
  });

  // Named for what it ASSERTS, not for the consequence. The user-visible cost — that head and its
  // running subtree hidden under a Running-only filter — lives in AgentSidebar's rowBandOf feeding
  // groupAgentsByStage, and is pinned there (AgentSidebar.rowChrome.test.tsx). Asserting it here
  // would be a tautology over two functions in this same module, dressed up as a column guarantee.
  //
  // The decision itself: the band follows the dot, so an unmerged head with live workers bands
  // `done`. The alternative was splitting dot from band, which breaks the "a chip hides exactly the
  // rows whose dot matches its color" contract in buildSections. The head is one chip away and
  // carries a real "Needs merge" you can act on.
  it("rolls unmerged + green up to gray, which bands done", () => {
    expect(bandOfRollup(rollupDot("unmerged", w("working")))).toBe("done");
  });
});

// ── The gray dot is LICENSED BY the peek — a folded head that owes a merge ─────────────────────
//
// THE THREE-FILE CONSPIRACY THIS BLOCK EXISTS TO MAKE UN-REINTRODUCIBLE (bead sparkle-qogah.3).
// Worker rows default to COLLAPSED, so a worker has no row of its own. Three modules each made a
// locally defensible choice and together they erased a worker the user owes an action to:
//
//   1. buildSections  — `unmerged` bands `done` (it is GRAY: a landing state, not an alarm).
//   2. workerRollup   — a gray worker contributes nothing to its parent's dot, so the head is gray.
//   3. workerExpansion — the peek admitted the `needs_you` band ONLY, so no peek line either.
//
// Net: an orchestrator with three workers each holding an un-landed PR rendered as ONE collapsed
// gray row filed under the "Done" chip. Three things the user owes, zero pixels — "he cannot know
// what he was not shown."
//
// HOW IT WAS FIXED, AND WHY ONLY HALF OF IT SURVIVED. 47bac7f85 changed (2) AND (3): the peek
// admits `unmerged`, and a child's `unmerged` escalated the parent dot. The dot half was reverted
// hours later by c7bd3e50c — `anyRed` is what `bandOfRollup` files under NEEDS YOU, so a folded
// head with an un-landed PR started counting as an ask, rebuilding one level up the wall of red
// that tokens.ts had torn down on 2026-07-26 (27 of 51 agents in that band) and making the chip
// mean two things at once (sparkle-345q5). Asked which surface was right, the founder endorsed the
// peek, verbatim: "it just peaks the one that's red and needs me and that's fine the way that it's
// working now."
//
// SO THE CURRENT LAW IS A COUPLED PAIR, AND NOTHING PINNED THE COUPLING. The head's dot is allowed
// to stay gray ONLY BECAUSE the peek names the worker. Those two facts live in two modules with two
// test files, so tightening the peek back to `needs_you`-only would have left every rollup test
// green and silently restored the original bug. Both halves are asserted here, in one test, over
// one fixture — mutate either module and this block goes red.
describe("a folded head whose worker owes a MERGE — the peek/dot pair", () => {
  // EVERY CANDIDATE IS MOUNTED AT ONCE. Asserting that an informational worker is absent from a
  // peek it was never offered to proves nothing (AGENTS.md, the `sparkle-foqoe` shape): a blanket
  // "peek everything" and a blanket "peek nothing" both satisfy a one-worker fixture. One head,
  // one owed worker, two calm ones — so the assertion pins the RULE rather than a headcount.
  const FOLDED = [
    { id: "head", kind: "build" as const, parentId: null },
    { id: "w-merge", kind: "worker" as const, parentId: "head" }, // owes: un-landed PR
    { id: "w-idle", kind: "worker" as const, parentId: "head" }, // informational: "Done — your turn"
    { id: "w-done", kind: "worker" as const, parentId: "head" }, // informational: finished
  ];
  const OWED: Record<string, AgentTabStatus> = {
    "w-merge": "unmerged",
    "w-idle": "idle",
    "w-done": "done",
  };
  const peek = (map: Record<string, AgentTabStatus>) =>
    attentionWorkersOf(FOLDED, "head", (id) => map[id] ?? "stopped", () => true).map((a) => a.id);

  it("names the unmerged worker and ONLY it, while the head stays gray", () => {
    // The half that satisfies the founder's rule: the row is not hidden, it is peeked. Tighten
    // `isOwedAsk` back to `needs_you`-only and this line goes red.
    expect(peek(OWED)).toEqual(["w-merge"]);
    // The half c7bd3e50c decided: the dot does NOT shout. Re-escalate a child's `unmerged` and
    // this line goes red — which is the point, because that escalation was tried and reverted.
    expect(rollupDot("idle", w("unmerged", "idle", "done"))).toBe("gray");
  });

  // THE COUPLING, STATED AS ONE IMPLICATION rather than two independent facts. Read the two
  // assertions above apart and the gray dot looks like plain absorption; read them together and
  // gray is a CLAIM — "nothing here is hidden from you" — that only the peek can make true.
  it("only lets the dot be calm because the peek is not empty", () => {
    const peeked = peek(OWED);
    const dot = rollupDot("idle", w("unmerged", "idle", "done"));
    expect(dot).toBe("gray");
    expect(peeked.length).toBeGreaterThan(0);
  });

  // THE NEGATIVE PAIR. Gray + no peek line is CORRECT when nothing is owed — that is a settled
  // fleet, and this is what stops the fix above from being satisfied by "peek everything", which
  // would turn the peek into the second, sneakier expansion the founder explicitly did not ask for
  // ("it's not expanded to show all workers").
  it("draws no peek line and stays gray when every worker is merely informational", () => {
    expect(peek({ "w-merge": "done", "w-idle": "idle", "w-done": "stopped" })).toEqual([]);
    expect(rollupDot("idle", w("done", "idle", "stopped"))).toBe("gray");
  });

  // …and the pair is not blanket in the other direction either: a worker that owes an ANSWER is
  // both peeked and escalated, because `needs_you` is an alarm and `unmerged` is a landing state.
  // Without this the "dot stays gray" assertion above would also pass for a rollup that had
  // stopped escalating everything.
  it("still paints the head red for a worker in the needs_you band", () => {
    expect(peek({ "w-merge": "blocked", "w-idle": "idle", "w-done": "done" })).toEqual(["w-merge"]);
    expect(rollupDot("idle", w("blocked", "idle", "done"))).toBe("red");
  });
});
