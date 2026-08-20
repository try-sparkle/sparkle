import { describe, it, expect } from "vitest";
import { EPIC_LADDER, bucketEpics, tasksOnly, type EpicLadderKey } from "./epicBoard";
import { bucketBeads, type Bead, type BeadStatus, type Board } from "./beads";

const bead = (
  id: string,
  status: BeadStatus,
  parent: string | null = null,
  extra: Partial<Bead> = {},
): Bead => ({ id, title: id, description: "", status, labels: [], parent, ...extra });

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
  // Backlog > Blocked > Planning > Building > Done > Shipped > Archived.
  // The KEYS reuse the Board snapshot's vocabulary wherever one already exists (inProgress,
  // delivered) so `Column`, its testids and its stage definitions keep working unchanged. Only
  // `planning` is new — the board never had a bucket for "the plan is written, nobody picked it up".
  it("is the seven stages, in the founder's reading order", () => {
    expect(EPIC_LADDER).toEqual([
      "backlog",
      "blocked",
      "planning",
      "inProgress",
      "done",
      "delivered",
      "archived",
    ]);
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
