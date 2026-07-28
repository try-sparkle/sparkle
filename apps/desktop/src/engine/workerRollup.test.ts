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
import { bandOfStatus } from "./buildSections";
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

  // `unmerged` is GRAY on purpose (tokens.ts: it is a LANDING state, not an alarm — it was red until
  // 2026-07-26, when 27 of 51 agents sat in that band and made red meaningless). The rollup must
  // inherit that judgement rather than quietly re-escalating it.
  it("keeps `unmerged` calm", () => {
    expect(rollupDot("unmerged", w())).toBe("gray");
    expect(rollupDot("idle", w("unmerged", "unmerged"))).toBe("gray");
  });

  it("does not let unmerged workers drag a green head off green", () => {
    expect(rollupDot("idle", w("working", "unmerged"))).toBe("green");
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
