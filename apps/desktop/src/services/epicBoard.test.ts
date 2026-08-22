import { describe, it, expect } from "vitest";
import {
  EPIC_LADDER,
  STAGE_LABELS,
  bucketEpics,
  emptyEpicBoard,
  ladderKeyOf,
  tasksOnly,
  withPlanning,
  type EpicLadderKey,
} from "./epicBoard";
import { bucketBeads, epicIndexOf, type Bead, type BeadStatus, type Board } from "./beads";

const bead = (
  id: string,
  status: BeadStatus,
  parent: string | null = null,
  extra: Partial<Bead> = {},
): Bead => ({
  id,
  title: id,
  description: "",
  status,
  labels: [],
  parent,
  commentCount: 0,
  ...extra,
});

const idsIn = (b: ReturnType<typeof bucketEpics>): Record<string, string[]> =>
  Object.fromEntries(EPIC_LADDER.map((k) => [k, b[k].map((x) => x.id)]));

/** Assert the chosen column holds exactly `ids` AND every other ladder column is empty.
 *  Absence in a column that was never populated proves nothing (AGENTS.md, the "N targets" trap),
 *  so every case below mounts all seven columns at once and checks the whole row. */
const only = (b: ReturnType<typeof bucketEpics>, key: EpicLadderKey, ids: string[]) => {
  const got = idsIn(b);
  expect(got[key]).toEqual(ids);
  for (const k of EPIC_LADDER) if (k !== key) expect(got[k]).toEqual([]);
};

describe("EPIC_LADDER", () => {
  // The founder's ladder, verbatim and in his reading order:
  // Backlog > Planning > Blocked > Unstaffed > Being built > Done > Shipped > Archived.
  //
  // UNSTAFFED WAS ADDED BETWEEN BLOCKED AND BEING BUILT, on his instruction, after he asked why an
  // epic can sit under "Being built" with no billed agent running against it. He chose the derived
  // rung over a new bead status explicitly: *"bead.status = in_progress + zero live agents bound ->
  // 'Unstaffed' (derived; no write to bd) ... an agent binds -> card slides right to 'Being built'
  // by itself, no sweep, no label."* Its POSITION is the part that has to be pinned here: one rung
  // left of Being built is what makes an agent binding look like the one-step slide it is.
  //
  // PLANNING MOVED LEFT OF BLOCKED on his instruction ("let's put Planning to the left of Blocked").
  // The earlier order had it third; this is the second spelling of the same list and the reason the
  // order is asserted at all — it is a founder-facing reading sequence, so it changes when he says
  // it does, and the change has to be visible here rather than silently in a render.
  //
  // The KEYS reuse the Board snapshot's vocabulary wherever one already exists (inProgress,
  // delivered) so `Column`, its testids and its stage definitions keep working unchanged. Only
  // `planning` is new — the board never had a bucket for "the plan is written, nobody picked it up".
  it("is the eight stages, in the founder's reading order", () => {
    expect(EPIC_LADDER).toEqual([
      "backlog",
      "planning",
      "blocked",
      "unstaffed",
      "inProgress",
      "done",
      "delivered",
      "archived",
    ]);
  });

  it("puts Unstaffed IMMEDIATELY left of Being built — the rung a card slides off and back onto", () => {
    // Asserted as a relationship as well as a position, so a future insertion between the two reds
    // here with a message about the pair rather than only as one row of the list above.
    expect(EPIC_LADDER.indexOf("unstaffed")).toBe(EPIC_LADDER.indexOf("inProgress") - 1);
    expect(EPIC_LADDER.indexOf("blocked")).toBe(EPIC_LADDER.indexOf("unstaffed") - 1);
  });
});

describe("bucketEpics — which ladder column an epic lands in", () => {
  it("splits an open epic whose children are ALL OPEN into Planning, not Backlog", () => {
    // The whole point of the column. `planning` is the state sparkle-xelans.8 shipped as a derived
    // status and that nothing has ever rendered; before this it sat in Backlog, visually identical
    // to an epic nobody has thought about yet.
    const all = [bead("e", "open"), bead("e.1", "open", "e"), bead("e.2", "open", "e")];
    only(bucketEpics(bucketBeads(all), all), "planning", ["e"]);
  });

  it("keeps a TYPED epic with no children in Backlog — a title, nothing decided yet", () => {
    const all = [bead("e", "open", null, { type: "epic" })];
    only(bucketEpics(bucketBeads(all), all), "backlog", ["e"]);
  });

  it("puts an open epic with a mix of open and closed children in Building", () => {
    const all = [bead("e", "open"), bead("e.1", "closed", "e"), bead("e.2", "open", "e")];
    only(bucketEpics(bucketBeads(all), all), "inProgress", ["e"]);
  });

  it("puts an open epic whose children are ALL CLOSED in Done — the work finished, the bead did not", () => {
    const all = [bead("e", "open"), bead("e.1", "closed", "e"), bead("e.2", "closed", "e")];
    only(bucketEpics(bucketBeads(all), all), "done", ["e"]);
  });

  // WHAT THIS PINS IS DISJOINTNESS, not an ordering — the first draft of this comment claimed the
  // epic's own column is consulted BEFORE the roll-up, and that is not the operating mechanism.
  // `columnFor` has already routed this bead to `blocked`, so the roll-up split never sees it and
  // the statement order in `bucketEpics` is irrelevant. The fixture is still worth having because
  // both facts are true of it at once: its children all sit open, so it WOULD roll up to
  // `planning` if anything ever routed the blocked pile through the split. Measured — doing
  // exactly that reds this case and only this case.
  it("lets the epic's OWN blocked state win over a child roll-up that says planning", () => {
    const all = [bead("e", "open", null, { labels: ["stalled"] }), bead("e.1", "open", "e")];
    const board = bucketBeads(all);
    expect(board.blocked.map((b) => b.id)).toEqual(["e"]); // precondition: it really is blocked
    only(bucketEpics(board, all), "blocked", ["e"]);
  });

  it("maps a delivered epic to Shipped and an archived one to Archived", () => {
    const all = [
      bead("s", "closed", null, { labels: ["delivered"] }),
      bead("s.1", "closed", "s"),
      bead("a", "closed", null, { labels: ["archived"] }),
      bead("a.1", "closed", "a"),
    ];
    const got = idsIn(bucketEpics(bucketBeads(all), all));
    expect(got.delivered).toEqual(["s"]);
    expect(got.archived).toEqual(["a"]);
    expect(got.done).toEqual([]);
  });

  // THE NEGATIVE CASE WITH EVERY COLUMN MOUNTED. One plain task is seeded into each of the six
  // source buckets at once, so "it isn't in Planning" cannot pass merely because nothing was there.
  it("excludes plain tasks from EVERY ladder column, not just the one under test", () => {
    const all = [
      bead("t-backlog", "open"),
      bead("t-blocked", "open", null, { labels: ["stalled"] }),
      bead("t-progress", "in_progress"),
      bead("t-done", "closed"),
      bead("t-shipped", "closed", null, { labels: ["delivered"] }),
      bead("t-archived", "closed", null, { labels: ["archived"] }),
    ];
    const got = idsIn(bucketEpics(bucketBeads(all), all));
    for (const k of EPIC_LADDER) expect(got[k]).toEqual([]);
  });

  it("shows the epic and hides the task from the SAME bucket — both mounted, one chosen", () => {
    const all = [bead("e", "open"), bead("e.1", "open", "e"), bead("t", "open")];
    const got = idsIn(bucketEpics(bucketBeads(all), all));
    expect(got.planning).toEqual(["e"]);
    expect(got.backlog).toEqual([]); // neither the task nor the epic is left behind here
  });
});

// ══ THE UNSTAFFED RUNG — "why is this under Being built with nothing running?" ═════════════════
//
// The founder, 2026-08-22, verbatim: *"I don't have a good understanding of why an epic can be in
// the being built category and yet there are no active billed agents running against it."*
//
// `bead.status` is stamped ONCE at promote-to-build and never re-derived, so the bead itself cannot
// answer him — measured that day, 129 beads sat `in_progress` with three touched in the last two
// hours. The roster can answer, and `bucketEpics` asks it through the optional `buildRungFor`
// supplier — which returns a RUNG rather than a boolean, because the founder named three outcomes
// (working, all-red, nobody) and a boolean could only ever carry two. Nothing is written to bd
// anywhere on this path.
//
// ══ WHY EVERY CASE MOUNTS A STAFFED EPIC BESIDE THE UNSTAFFED ONE ══════════════════════════════
// "seed one unstaffed epic, assert it is in Unstaffed" passes against a predicate that is never
// called, against a rule wired to a constant, and against one that files EVERY in-progress epic
// under the new rung. So each case below stands the two side by side and asserts they SEPARATE —
// and the paired case re-runs the identical fixture with the predicate inverted, because one test
// proving absence is ambiguous and the pair is what pins the cause.
describe("bucketEpics — the Unstaffed rung, derived from the live roster", () => {
  /** Two epics the board files under Being built, told apart only by who is on them. */
  const twoInProgress = () => [
    bead("e-staffed", "in_progress", null, { type: "epic" }),
    bead("e-bare", "in_progress", null, { type: "epic" }),
  ];
  /** The named epics are actively built; everything else has nobody on it.
   *
   *  Returns a RUNG, not a boolean, because that is what `bucketEpics` now takes — a boolean could
   *  only ever say inProgress-or-unstaffed, which left the founder's "all agents red -> Blocked"
   *  arm with nowhere to land. See the `red` case at the bottom of this describe. */
  const staffedIs =
    (...ids: string[]) =>
    (id: string): "blocked" | "unstaffed" | "inProgress" =>
      ids.includes(id) ? "inProgress" : "unstaffed";
  /** Nobody anywhere. */
  const nobodyStaffed = () => "unstaffed" as const;

  it("routes an in_progress epic with NOBODY on it to Unstaffed, and leaves its staffed sibling in Being built", () => {
    const all = twoInProgress();
    const board = bucketBeads(all);
    // PRECONDITION, stated so a fixture that stopped reaching this route reds here rather than
    // passing for the wrong reason: bd's own bucketing puts BOTH under Being built today.
    expect(board.inProgress.map((b) => b.id)).toEqual(["e-staffed", "e-bare"]);

    const got = idsIn(bucketEpics(board, all, staffedIs("e-staffed")));
    // THE SIDE EFFECT: the bare epic MOVED. Present in the new rung...
    expect(got.unstaffed).toEqual(["e-bare"]);
    // ...and ABSENT from the column whose header was lying about it. This is the assertion the
    // founder's complaint is actually about; the line above alone would pass for a card rendered in
    // both places at once.
    expect(got.inProgress).toEqual(["e-staffed"]);
  });

  it("...and the SAME fixture with the predicate inverted swaps them — the pair that pins the cause", () => {
    // Identical beads, identical board, one thing different. A rule that ignored `isStaffed`, or
    // that keyed off anything on the bead (its id, its type, its position), passes the case above
    // and fails this one.
    const all = twoInProgress();
    const got = idsIn(bucketEpics(bucketBeads(all), all, staffedIs("e-bare")));
    expect(got.unstaffed).toEqual(["e-staffed"]);
    expect(got.inProgress).toEqual(["e-bare"]);
  });

  it("applies the same rule to an OPEN epic that reaches Being built through its CHILDREN", () => {
    // ROUTE 2. `openEpicStage` sends an open epic with a mix of open and closed children to
    // Being built — a different code path into the same rung, and one a fix covering only the
    // `board.inProgress` copy-through would leave dishonest. Both routes are mounted at once.
    const all = [
      bead("e-kids-staffed", "open"),
      bead("e-kids-staffed.1", "closed", "e-kids-staffed"),
      bead("e-kids-staffed.2", "open", "e-kids-staffed"),
      bead("e-kids-bare", "open"),
      bead("e-kids-bare.1", "closed", "e-kids-bare"),
      bead("e-kids-bare.2", "open", "e-kids-bare"),
    ];
    const board = bucketBeads(all);
    // PRECONDITION: both epics are in the OPEN pile, i.e. nothing about their own status put them
    // in Being built. Only the child roll-up does, which is the route under test.
    expect(board.inProgress).toEqual([]);

    const got = idsIn(bucketEpics(board, all, staffedIs("e-kids-staffed")));
    expect(got.unstaffed).toEqual(["e-kids-bare"]);
    expect(got.inProgress).toEqual(["e-kids-staffed"]);
    // Their children are plain tasks and belong to neither rung.
    expect(got.backlog).toEqual([]);
    expect(got.planning).toEqual([]);
  });

  it("diverts ONLY the Being-built rung — a blocked, planning, backlog or done epic stays put", () => {
    // THE NEGATIVE THAT THE THREE CASES ABOVE CANNOT SEE. `isStaffed` answers false for every id
    // here, so a rule written as "unstaffed epics go to Unstaffed" — rather than "epics that would
    // land in Being built and have nobody on them" — empties four other rungs into the new one and
    // still passes every case above. Every candidate rung is mounted at once so absence is a real
    // observation rather than an empty column.
    const all = [
      bead("e-blocked", "open", null, { labels: ["stalled"] }),
      bead("e-blocked.1", "open", "e-blocked"),
      bead("e-planning", "open"),
      bead("e-planning.1", "open", "e-planning"),
      bead("e-backlog", "open", null, { type: "epic" }),
      bead("e-done", "open"),
      bead("e-done.1", "closed", "e-done"),
      bead("e-shipped", "closed", null, { labels: ["delivered"] }),
      bead("e-shipped.1", "closed", "e-shipped"),
      bead("e-live", "in_progress", null, { type: "epic" }),
    ];
    const got = idsIn(bucketEpics(bucketBeads(all), all, nobodyStaffed));
    // ONLY the Being-built one moved.
    expect(got.unstaffed).toEqual(["e-live"]);
    expect(got.inProgress).toEqual([]);
    expect(got.blocked).toEqual(["e-blocked"]);
    expect(got.planning).toEqual(["e-planning"]);
    expect(got.backlog).toEqual(["e-backlog"]);
    expect(got.done).toEqual(["e-done"]);
    expect(got.delivered).toEqual(["e-shipped"]);
  });

  it("is UNCHANGED with the predicate omitted — nothing can reach Unstaffed without a roster", () => {
    // The compatibility contract every rosterless caller and every fixture in this file leans on.
    // Both routes into Being built are seeded, so this is not satisfied by an empty board.
    const all = [
      bead("e-own", "in_progress", null, { type: "epic" }),
      bead("e-kids", "open"),
      bead("e-kids.1", "closed", "e-kids"),
      bead("e-kids.2", "open", "e-kids"),
    ];
    const got = idsIn(bucketEpics(bucketBeads(all), all));
    expect(got.unstaffed).toEqual([]);
    expect(got.inProgress).toEqual(["e-own", "e-kids"]);
  });

  it("keeps plain TASKS out of the Unstaffed rung, however the predicate answers", () => {
    // Epic-ness is decided before staffing is ever asked, and a task in Being built with nobody on
    // it is the overwhelmingly common case — filing those here would bury the epics the rung exists
    // to surface. The epic beside them proves the rung is reachable in this same fixture.
    const all = [
      bead("t1", "in_progress"),
      bead("t2", "in_progress"),
      bead("e", "in_progress", null, { type: "epic" }),
    ];
    only(bucketEpics(bucketBeads(all), all, nobodyStaffed), "unstaffed", ["e"]);
  });

  // ══ THE ARM THAT HAD NO PRODUCTION CALLER UNTIL THE RUNG BECAME THE ARGUMENT ═════════════════
  // The founder: *"if there are not any [agents] and it's not finished then by definition it should
  // be considered blocked … Meaning if the agents are Red then it would go into blocked."* Three
  // outcomes, not two — which is exactly what a boolean `isStaffed` could not carry. While this
  // took a boolean, `engine/epicHealth.rungForEpicHealth` held the red->blocked rule and NOTHING in
  // the app called it: its tests were green over a path the screen could never reach.
  it("routes an epic whose whole fleet is RED into Blocked, beside the dependency-blocked work", () => {
    const all = twoInProgress();
    const board = bucketBeads(all);
    // Same precondition as above — bd files both under Being built, so nothing here is pre-sorted.
    expect(board.inProgress.map((b) => b.id)).toEqual(["e-staffed", "e-bare"]);

    const got = idsIn(
      bucketEpics(board, all, (id) => (id === "e-staffed" ? "blocked" : "unstaffed")),
    );
    // THE SIDE EFFECT: it left the build rungs entirely and joined the lane he already scans.
    expect(got.blocked).toEqual(["e-staffed"]);
    // ...and is absent from BOTH build rungs. Asserting only its arrival would pass for a card
    // rendered in two columns at once, and asserting only its absence from `inProgress` would pass
    // for a rule that quietly filed it as unstaffed instead — which is a different claim about the
    // epic (nobody came) than the one the fleet is making (everyone is stuck).
    expect(got.inProgress).toEqual([]);
    expect(got.unstaffed).toEqual(["e-bare"]);
  });
});

describe("tasksOnly + bucketEpics — the two halves the Tasks and Epics modes render", () => {
  const all = [bead("e", "open"), bead("e.1", "open", "e"), bead("t", "open")];
  const board: Board = bucketBeads(all);

  it("tasksOnly drops the epic and keeps its children and plain tasks", () => {
    expect(tasksOnly(board, all).backlog.map((b) => b.id)).toEqual(["e.1", "t"]);
  });

  // THE PARTITION IS THE ASSERTION WITH POWER, and it needs BOTH halves computed from one snapshot.
  // Either half alone is satisfied by a bead that vanished from the app entirely: `tasksOnly`
  // hiding the epic looks identical whether the Epics mode shows it or not. Pinning that the union
  // is the whole board and the intersection is empty is what makes "no mode can lose work" a fact
  // rather than a comment. Note the halves are asked in the shapes the modes actually render —
  // `tasksOnly` returns task columns, `bucketEpics` the seven-stage ladder — because a partition
  // over some third representation neither mode uses would prove nothing about either.
  it("partition the board — every bead is in exactly one half, none in both", () => {
    const t = tasksOnly(board, all);
    const e = bucketEpics(board, all);
    const flat = (o: Record<string, Bead[]>) => Object.values(o).flat().map((b) => b.id);
    const tasks = flat(t as unknown as Record<string, Bead[]>);
    const epics = flat(e as unknown as Record<string, Bead[]>);
    expect([...tasks, ...epics].sort()).toEqual(["e", "e.1", "t"]);
    expect(tasks.filter((id) => epics.includes(id))).toEqual([]);
  });
});

// ══ THE CACHE IS ACTUALLY USED — pinned by a READ COUNT, not by output equality ════════════════
//
// `bucketEpics`/`tasksOnly` used to call the UNCACHED `buildEpicIndex(allBeads)` directly, on the
// same `allBeads` identity every Card and EpicRow already resolves through `epicIndexOf` — so the
// Plan board paid a second full O(n) walk on every render (roborev 65662).
//
// OUTPUT EQUALITY CANNOT GUARD THIS. Both spellings return identical data, so every other test in
// this file stays green if the two lines are reverted; the only symptom is silent duplicated work
// (roborev 65714). What distinguishes them is how many times the STORE ARRAY is read, so that is
// what this counts — the same Proxy technique as the complexity block in `beads.epicIndex.test.ts`.
describe("bucketEpics / tasksOnly read the CACHED index", () => {
  const N = 400;

  const counted = (store: Bead[]) => {
    const stats = { reads: 0 };
    const proxy = new Proxy(store, {
      get(target, prop, recv) {
        if (typeof prop === "string" && prop.length > 0 && /^\d+$/.test(prop)) stats.reads++;
        return Reflect.get(target, prop, recv);
      },
    }) as Bead[];
    return { proxy, stats };
  };

  const store = (): Bead[] => {
    const out: Bead[] = [];
    for (let e = 0; e < 8; e++) out.push(bead(`e${e}`, "open"));
    for (let i = 0; out.length < N; i++) out.push(bead(`t${i}`, "open", `e${i % 8}`));
    return out;
  };

  it("does not re-walk the store once the index is primed", () => {
    // THE BOARD IS BUILT FROM A SEPARATE ARRAY, not from the proxy. An earlier version wrote
    // `bucketBeads([...proxy])` with the comment "a COPY, so bucketing is not charged" -- which was
    // false: array spread goes through the ITERATOR PROTOCOL, issuing Get(target, "0"), Get(target,
    // "1"), ... so every element hit the trap and ~N reads were charged before priming ever ran.
    // That made the `primed > 0` guard below unfalsifiable -- it would have passed against an
    // `epicIndexOf` that read nothing at all, which is the exact shape this suite exists to catch
    // (roborev 65724).
    const beads = store();
    const board = bucketBeads(store());
    const { proxy, stats } = counted(beads);

    const beforePrime = stats.reads;
    epicIndexOf(proxy);
    // The priming walk really happened, measured around the call ALONE.
    expect(stats.reads - beforePrime).toBeGreaterThanOrEqual(N);
    const primed = stats.reads;

    const epics = bucketEpics(board, proxy);
    const tasks = tasksOnly(board, proxy);

    // POSITIVE GUARD FIRST: both did real work. Without it the read-delta assertion below is
    // satisfied trivially by an early bail -- an empty board, a rejecting predicate, a `return
    // emptyEpicBoard()` -- and the test stays green while measuring nothing. Every sibling
    // read-count test carries this pair for the same reason.
    expect(EPIC_LADDER.reduce((n, k) => n + epics[k].length, 0)).toBeGreaterThan(0);
    expect(tasks.backlog.length).toBeGreaterThan(0);

    // ...and neither added another full pass. A single reverted line costs N more reads, so this
    // bar sits well below the failure it is written to catch.
    expect(stats.reads - primed).toBeLessThan(N);
  });
});

// ══ ONE VOCABULARY FOR A STAGE (bead sparkle-az6di8) ══════════════════════════════════════════
// This file used to spell the ladder's labels inline while `BoardView` spelled its own copy, and
// the two had drifted: `inProgress` was "Building" here and "Being built" there — the same column
// with two names, which a reader saw as a stage renaming itself when they toggled Epics. The
// end-to-end proof (both headers rendered, then compared) lives in BoardView.test.tsx; these rows
// pin the source of truth those headers read from.
describe("STAGE_LABELS — the one place a stage is put into words", () => {
  it("covers every ladder rung, so no column can fall back to its wire key", () => {
    for (const key of EPIC_LADDER) {
      expect(STAGE_LABELS[key], key).toBeTruthy();
      // The label is for a human. A value that equalled the key would mean a column rendering
      // `inProgress` at the reader, which is the class of bug this record exists to end.
      expect(STAGE_LABELS[key]).not.toBe(key);
    }
  });

  it("labels the two build rungs 'Build: Unstaffed' and 'Build: Active' — one stage, two states", () => {
    expect(STAGE_LABELS.inProgress).toBe("Build: Active");
    expect(Object.values(STAGE_LABELS)).not.toContain("Building");
  });

  it("prefixes the derived rung so it reads as a BUILD state, not a fourth kind of not-started", () => {
    // It is the word he wrote in the ladder he picked, and it is the one the header renders. A
    // near-miss ("Unassigned", "No agent", "Idle") would be a second vocabulary for a state the app
    // already names `unstaffed` in `engine/epicHealth` and describes to the user as "Nobody is
    // working on this epic".
    expect(STAGE_LABELS.unstaffed).toBe("Build: Unstaffed");
  });

  // ── THE ROW THAT ACTUALLY BITES: `EPIC_LADDER` MUST COVER EVERY RUNG ────────────────────────
  // `EPIC_LADDER_COLUMNS` is derived from `EPIC_LADDER` + `STAGE_LABELS`, so asserting that it
  // equals its own two sources proves nothing — it restates the implementation and survives any
  // mutation of it (roborev 65866). The invariant that IS load-bearing is the one neither the type
  // system nor the row above can state: `EPIC_LADDER` is an ARRAY of `EpicLadderKey`, satisfied by
  // any subset, while every `Record<EpicLadderKey, …>` beside it is forced complete. So an eighth
  // rung added to the type compiles everywhere except here — and then the ladder never renders
  // that column, `ladderKeyOf` answers null for every bead in it, and `BeadPill`'s placement index
  // skips them, so those chips fall back to `columnFor` and print a stage with no header on
  // screen. Three silent failures from one omission. The `satisfies` clause in `epicBoard.ts` now
  // makes it a compile error too; this is the runtime half, and it survives someone rewriting that
  // list as a plain literal.
  it("covers EVERY key of STAGE_LABELS — a rung missing from the order list is silent otherwise", () => {
    expect([...EPIC_LADDER].sort()).toEqual(Object.keys(STAGE_LABELS).sort());
    // …and every key the BOARD itself has, which is what `ladderKeyOf` walks.
    expect([...EPIC_LADDER].sort()).toEqual(Object.keys(emptyEpicBoard()).sort());
    // No duplicates: a repeated key would satisfy both sets above while rendering twice.
    expect(new Set(EPIC_LADDER).size).toBe(EPIC_LADDER.length);
  });
});

// ══ `ladderKeyOf` — WHICH BUCKET ALREADY HOLDS A BEAD ═════════════════════════════════════════
// The status chip's whole input. It reads the placement back off the board rather than re-deriving
// it, which is the only way the chip can agree with the header above it in BOTH modes.
describe("ladderKeyOf", () => {
  const beads = [
    bead("e1", "open"),
    bead("e1.1", "open", "e1"), // all children open → the epic rolls up to Planning
    bead("t1", "in_progress"),
    bead("t2", "closed"),
  ];

  it("answers with the LADDER rung on an epic board — Planning, which no bead records", () => {
    const board = bucketEpics(bucketBeads(beads), beads);
    // The epic's own status is plain `open`; only its children put it in Planning. A chip that
    // re-derived from the bead could never reach this answer.
    expect(ladderKeyOf(board, "e1")).toBe("planning");
  });

  it("answers with the board COLUMN on a task board — the same bead, a different bucketing", () => {
    expect(ladderKeyOf(withPlanning(bucketBeads(beads)), "e1")).toBe("backlog");
    expect(ladderKeyOf(withPlanning(bucketBeads(beads)), "t1")).toBe("inProgress");
    expect(ladderKeyOf(withPlanning(bucketBeads(beads)), "t2")).toBe("done");
  });

  it("takes a plain six-column Board too — the shape the beads store keeps", () => {
    // Bucketed WITH a blocked set — `e1.1` is a plain OPEN bead carrying nothing that says so, and
    // blockedness is a dependency fact bd answers separately. This is the answer `columnFor` can
    // only give when handed that set, i.e. the one a chip re-derived from the bead would lose.
    const board: Board = bucketBeads(beads, new Set(["e1.1"]));
    expect(ladderKeyOf(board, "e1.1")).toBe("blocked");
    expect(ladderKeyOf(board, "e1")).toBe("backlog");
  });

  it("returns null for a bead no column holds, rather than throwing", () => {
    expect(ladderKeyOf(withPlanning(bucketBeads(beads)), "nope")).toBeNull();
    // A partial fixture (a test double, a snapshot mid-load) degrades the same way.
    expect(ladderKeyOf({} as unknown as Board, "t1")).toBeNull();
  });
});
