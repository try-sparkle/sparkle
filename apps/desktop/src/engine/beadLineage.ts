/**
 * ONE CARD'S LINEAGE — the parent above it, the tasks below it, and the build agents on those
 * tasks — resolved ONCE, as data, so every surface draws the same two rows.
 *
 * ══ WHY THIS IS AN ENGINE AND NOT THREE `useMemo`s IN THREE COMPONENTS ══════════════════════
 * The founder, 2026-08-22: *"I should always be able to see the children or parent of any card"*,
 * and — about the two rows — *"whether it's in the concierge chat or on the planning board, I think
 * it would still just show me two rows, one for tasks and one for build agents if appropriate."*
 * IDENTICAL ON EVERY SURFACE is the requirement, not a nicety. A card that computes its own lineage
 * is a card that can disagree with the next one, and "always" then quietly means "usually".
 *
 * ══ THE FLAT UNION IS THE SPEC, NOT A SHORTCUT ═════════════════════════════════════════════
 * `buildAgents` is a FLAT UNION across the card's tasks — it does not say which agent is on which
 * child. The founder chose that explicitly: *"maybe I can't see the exact relationship between each
 * child task and its specific build agents, but I can see basically all of them."* Do not grow a
 * nested task→agent mapping here; that shape was considered and declined.
 *
 * ══ MEMBERSHIP HAS ONE OWNER — AND THERE WERE ALREADY FOUR ═════════════════════════════════
 * Children come from `childrenOfIndexed` and the parent from `parentEpicOfIndexed`, both in
 * `services/beads.ts`, which owns the epic-membership edge. Agents come from `agentIdsInEpic`
 * (`engine/epicFocus.ts`) — the SAME resolver the Build column filters on.
 *
 * That last point is the whole reason this module exists rather than a `useMemo` per surface. The
 * tree already carried FOUR different answers to "which agents belong to this bead" —
 * `workersForBead` (exact bead, workers only), `workersInEpic` (one level, workers only),
 * `agentIdsInEpic` (full closure, any kind) and `agentsForEpicSlices` (both edges to a fixpoint) —
 * and each surface used a different one. A card that says "27 build agents" while the column it
 * opens shows a different set is a contradiction on the founder's screen, and a number that
 * disagrees with the click is worse than no number at all.
 *
 * `scripts/lib/epic-membership-guard.sh` FAILS CI ON A FIFTH DEFINITION. Reuse a resolver; never
 * filter membership at a call site.
 *
 * ══ WHAT THE BUILD-AGENT SET IS — AND WHAT THE BUILD COLUMN DRAWS ══════════════════════
 * `buildAgents` is EVERY AGENT, HEAD OR WORKER, whose bead is in this bead's closure. That is a
 * MEMBERSHIP question and it has one owner (`agentIdsInEpic`). It is NOT the Build column's ROW
 * POPULATION, and the two are different sizes ON PURPOSE — see the comment at the resolver call
 * below. The card's count can legitimately EXCEED the number of rows the column draws, because a
 * worker never claims a row of its own there. Do not restate that difference away as an equality.
 *
 * ══ INDEXED, NEVER A RAW SCAN ══════════════════════════════════════════════
 * Callers hand over the store's bead array UNCHANGED, and HALF of that path is cached upstream:
 * `epicIndexOf` IS WeakMap-cached on array IDENTITY (`services/beads.ts`), so a copy, slice or
 * re-sort defeats it — on the founder's 7,364-bead store a naive per-card scan measured 3.4–4.0s /
 * 53.7M comparisons, and a card re-renders on every 5s poll.
 *
 * `descendantsOf` — which `agentIdsInEpic` composes — is NOT cached, and this comment used to claim
 * it was. It builds a fresh `byParent` Map over every bead, does a second full prefix scan and ends
 * in a `beads.filter`: three O(n) passes PER CALL, with `agentIdsInEpic`'s own `new Map(agents.map(
 * …))` and two parent walks on top. Since `beadLineageOf` runs once per card render and the
 * concierge mounts a card for every bead the thread ever named, that is the whole store re-walked
 * per card per poll. Rather than reach into `services/beads.ts`, the membership answer is memoised
 * HERE — see {@link epicAgentCache}.
 */

import type { AgentTab } from "../types";
import type { Bead } from "../services/beads";
import { childrenOfIndexed, epicIndexOf, parentEpicOfIndexed } from "../services/beads";
import { agentIdsInEpic, type EpicFocusAgent } from "./epicFocus";

/**
 * One thing on a lineage row.
 *
 * `id` is what a click resolves — a bead id for a task, an AGENT id for a build agent. `projectId`
 * is carried only for agents, because revealing an agent is addressed by project
 * (`onOpenAgent({ agentId, projectId })`, mirroring `Concierge/AgentPill`); a bead pill is resolved
 * against the card's own project and needs none.
 */
export interface LineagePill {
  id: string;
  /** What the pill READS. A bead's title (never its id — the founder asked for "the name of each
   *  task as a pill"), or an agent's display name. Falls back to the id when a bead is untitled. */
  label: string;
  /** Set for build-agent pills only; the project that owns the agent row. */
  projectId?: string;
}

/** Everything the two lineage rows need, for one card. */
export interface BeadLineage {
  /**
   * The nearest ancestor epic, or null. A PILL ON THE MERGED META LINE rather than a row of its
   * own — the founder's call, 2026-08-22, when asked where the parent goes in the collapsed state:
   * it costs zero extra height and keeps "just two rows, one for tasks and one for build agents"
   * literally true. Most beads are tasks inside an epic, so a third row would have been a height
   * cost on the MAJORITY of cards — the exact height this whole change is reclaiming.
   */
  parent: Bead | null;
  /** Direct children. The `Tasks:` row. Empty renders NO row and no bare label. */
  tasks: LineagePill[];
  /** The flat union of build agents — orchestrators AND workers — across this bead and everything
   *  under it. The `Build agents:` row. Deliberately NOT a per-task mapping: the founder accepted
   *  that fidelity loss ("maybe I can't see the exact relationship... but I can see basically all
   *  of them"). Workers are IN, so this row's length can EXCEED the number of rows the Build column
   *  draws for the same bead — that column renders heads only. Distinct by agent id. */
  buildAgents: LineagePill[];
}

/**
 * IS THIS CARD IN ACTIVE BUILD — the condition on the `Build agents:` row.
 *
 * The founder: *"if it's in active build mode, so if it's not just in planning, so if appropriate,
 * basically."* This answers it with the ONE fact that cannot disagree with the row itself: whether
 * any build agent resolves to this bead or anything under it.
 *
 * WHY NOT THE WORKFLOW STAGE. A stage word is a SECOND source of truth for the same question, and
 * the two drift: a bead can read "planned" while three workers are mid-flight (the stage is rolled
 * up on a poll), and an epic parked in Backlog can still be staffed. Keying the row on the pills it
 * would render makes "appropriate" mean exactly "there is something to show" — so the row can never
 * appear empty and can never hide agents that exist.
 */
export function inActiveBuild(lineage: Pick<BeadLineage, "buildAgents">): boolean {
  return lineage.buildAgents.length > 0;
}

/** One snapshot pair's answers: which agent ids belong to a given bead's closure. */
interface CachedEpicAgents {
  /** `beads.length` this entry was resolved from — the staleness guard, see {@link epicAgentCache}. */
  beadCount: number;
  /** `agents.length` this entry was resolved from — same guard, other array. */
  agentCount: number;
  /** Per bead id, exactly what `agentIdsInEpic` returned (`null` included, it is a real answer). */
  byBeadId: Map<string, ReadonlySet<string> | null>;
}

/**
 * MEMBERSHIP, MEMOISED PER SNAPSHOT — the missing half of the cache the header used to claim.
 *
 * `agentIdsInEpic` composes `descendantsOf`, which is UNCACHED and walks the whole store three
 * times per call (`services/beads.ts`). `beadLineageOf` runs once per card render and the concierge
 * mounts a card for every bead the thread ever named, all of them re-rendering on the 5s poll — so
 * on the founder's 7,364-bead store a fifty-card thread re-walked the whole store fifty times per
 * poll for an answer that had not changed (roborev 68039 put the arithmetic at ~1.1M extra
 * comparisons plus ~7.4k Map insertions per card per poll; that is an ESTIMATE, not a measurement
 * taken here). This holds the answer instead. It is the only thing this module caches;
 * `services/beads.ts` is not ours to edit and is left exactly as it is.
 *
 * KEYED ON BOTH ARRAYS' IDENTITY, nested so neither array is held alive by the other. The staleness
 * contract is the SAME ONE `epicIndexOf` already documents and the same one every caller already
 * has to honour: a `WeakMap` cannot see an array mutated IN PLACE. The stored lengths catch every
 * mutation that changes a length (push/pop/splice); an in-place field edit at constant length is
 * not detectable without the per-element scan this exists to remove. `beadsStore` maps a fresh
 * array per poll, which is what makes that contract hold.
 *
 * Note what is NOT keyed: an agent's NAME. Labels are read from the roster on every call, below, so
 * a renamed agent still renders its new name off a cache hit — only membership is memoised.
 */
const epicAgentCache = new WeakMap<
  readonly Bead[],
  WeakMap<object, CachedEpicAgents>
>();

/** {@link agentIdsInEpic} for this exact snapshot pair, resolved once. */
function epicAgentIdsMemo(
  beads: readonly Bead[],
  agents: readonly EpicFocusAgent[],
  beadId: string,
): ReadonlySet<string> | null {
  let byAgents = epicAgentCache.get(beads);
  if (byAgents === undefined) {
    byAgents = new WeakMap<object, CachedEpicAgents>();
    epicAgentCache.set(beads, byAgents);
  }
  let entry = byAgents.get(agents);
  if (entry === undefined || entry.beadCount !== beads.length || entry.agentCount !== agents.length) {
    entry = { beadCount: beads.length, agentCount: agents.length, byBeadId: new Map() };
    byAgents.set(agents, entry);
  }
  // `has` rather than a truthiness test on `get`: `null` is a MEANINGFUL answer from the resolver
  // ("no narrowing at all"), so caching it and then re-resolving it every time would memoise
  // nothing on exactly the path that returns fastest to compute and slowest to notice.
  if (entry.byBeadId.has(beadId)) return entry.byBeadId.get(beadId) ?? null;
  const resolved = agentIdsInEpic(agents, beads, beadId);
  entry.byBeadId.set(beadId, resolved);
  return resolved;
}

/**
 * Resolve one card's lineage.
 *
 * `agents` is the containing project's agent roster; `projectId` is that project, stamped onto each
 * agent pill so a click can address the reveal.
 *
 * ORDER-STABLE on the roster, so the row does not reshuffle between the store's polls. Agents are
 * kept DISTINCT BY ID and never merged on display name: two live agents can share a name, and
 * collapsing them would silently drop one from a row whose entire purpose is "I can see basically
 * all of them". The de-dupe is on the ID because that id is BOTH the React `key` on the rendered
 * pill (`BeadCard/BeadLineageRows`) and the count {@link inActiveBuild} gates the row on: a roster
 * that lists one agent twice would otherwise draw two same-keyed pills and double the number.
 */
export function beadLineageOf(params: {
  /** The project's FULL bead snapshot, straight from the store — not a copy, slice or re-sort.
   *  `epicIndexOf` is WeakMap-cached on array IDENTITY, and so is this module's own membership memo
   *  ({@link epicAgentCache}); a fresh array per card defeats BOTH and puts a full store walk on
   *  the 5s poll. */
  beads: readonly Bead[];
  bead: Bead;
  agents: readonly Pick<AgentTab, "id" | "name" | "kind" | "beadId" | "parentId">[];
  projectId: string;
}): BeadLineage {
  const { beads, bead, agents, projectId } = params;

  const index = epicIndexOf(beads);
  const parent = parentEpicOfIndexed(index, bead);

  const children = childrenOfIndexed(index, bead.id);
  const tasks: LineagePill[] = children.map((c) => ({ id: c.id, label: c.title || c.id }));

  // ══ ONE MEMBERSHIP RESOLVER — THE ONE THE BUILD COLUMN ALSO FILTERS WITH ═══════════════════
  // The tree already held FOUR different answers to "which agents belong to this bead", and each
  // surface used a different one — so a card and the column it opens could disagree about who is
  // even ON this epic. `agentIdsInEpic` is the resolver the BUILD COLUMN composes its filter from,
  // so that question now has one answer everywhere. Three properties matter:
  //
  //   • IT INCLUDES ORCHESTRATORS, not just workers. The founder said "build agents", which is what
  //     the Build column calls heads. A worker-only rule renders an orchestrator that has not yet
  //     spawned anyone on NO card at all, while it still survives the column filter.
  //   • IT IS TRANSITIVE. `childrenOfIndexed` is ONE level, so a worker on a reparented grandchild
  //     was silently missing from its epic's card.
  //   • IT SEEDS WITH THE ID YOU HAND IT, so a TASK bead narrows correctly too — no special case
  //     for "this card is a task, not an epic".
  //
  // NEVER filter membership at this call site instead: `scripts/lib/epic-membership-guard.sh` fails
  // CI on a re-derivation, and a fifth rule is exactly the drift above.
  //
  // ── WHAT THIS ROW IS NOT: THE BUILD COLUMN'S ROW SET ──────────────────────────────────────
  // Sharing the membership resolver does NOT make these two sets equal, and an earlier version of
  // this comment claimed it did. `AgentSidebar`'s `sections` memo computes `topLevelOf(
  // project.agents, mode)` FIRST and only then intersects with `agentIdsInEpic`, and
  // `isTopLevelAgent` (`engine/agentOrdering.ts`) excludes `kind === "worker"` outright — a worker
  // is drawn nested under its head, never as a row of its own. So the column DRAWS HEADS while
  // this row lists heads PLUS every worker in the closure: an epic with 1 head and 26 workers
  // reads "27 build agents" here beside 1 row there.
  //
  // THAT ASYMMETRY IS THE FOUNDER'S CALL, not a defect to close by narrowing to heads: *"maybe I
  // can't see the exact relationship between each child task and its specific build agents, but I
  // can see basically all of them."* Narrowing would hide the very agents he asked to see. What is
  // forbidden is the CLAIM — do not write, here or in a commit message, that the card's count and
  // the column's visible row count are the same number. They are two different questions with two
  // different answers, and only the first one is shared.
  const inEpic = epicAgentIdsMemo(beads, agents, bead.id);
  const buildAgents: LineagePill[] = [];
  if (inEpic !== null) {
    // THE ROW'S ORDER IS THE ROSTER'S, never the set's — filtered FROM `agents`, so the ordering
    // is a property of the array this line reads and not of insertion into a `Set`.
    // `agentIdsInEpic` matches a worker directly in its first pass and lifts that worker's HEAD in
    // a SECOND, so its set hands back the worker BEFORE the orchestrator that owns it; iterating
    // `inEpic` would put the head last and reshuffle the pills as agents come and go across polls.
    //
    // WRITTEN AS A STATEMENT ON A LINE OF ITS OWN, mirroring `AgentSidebar`'s `ladderInput`, so the
    // rule is one readable line rather than a condition folded into the `for (...)` header.
    //
    // PROVEN LOAD-BEARING BY HAND, not by `scripts/mutation-check.sh`: that script's first strategy
    // swaps `<`/`>`, which mangles this line's `=>` into `=<`, so esbuild rejects the mutant and the
    // site comes back "could not be judged" rather than caught. The mutation that matters is not a
    // comment-out anyway — it is `[...inEpic]` in place of `agents.filter(...)`, i.e. taking the
    // resolver's set order instead of the roster's. Run by hand, that turns TWO tests red:
    // "orders pills by the ROSTER…" and "counts one head PLUS its two workers…". Re-run it that way
    // if you change this line.
    const inRosterOrder = agents.filter((a) => inEpic.has(a.id));
    const seen = new Set<string>();
    for (const a of inRosterOrder) {
      // DE-DUPED ON THE ID, because that id is the rendered pill's React `key` and feeds the count
      // `inActiveBuild` gates on — a roster listing one agent twice would draw two same-keyed pills
      // and double the number. Note this is the ID, never the display name: two live agents sharing
      // a name are two agents.
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      buildAgents.push({ id: a.id, label: a.name, projectId });
    }
  }

  return { parent, tasks, buildAgents };
}

/** What {@link packPills} decided: how many pills to draw, and how many are left over. */
export interface PillPacking {
  /** How many of the pills, in order, to render. At least 1 whenever there is anything at all. */
  shown: number;
  /** The remainder, for the trailing "+N more". 0 means everything fit and NO overflow is drawn. */
  overflow: number;
}

/**
 * FIT AS MANY PILLS AS THE ROW HOLDS, THEN "+N MORE" — as a PURE function of measured widths.
 *
 * ══ WHY THE DECISION IS SEPARATED FROM THE MEASUREMENT ═════════════════════════════════════
 * "As many as fit" is a LAYOUT question, and jsdom never lays out — it reports every width as 0 and
 * never fires a `ResizeObserver` (`docs/jsdom-test-caveats.md`). A component that measured and
 * decided in one place would therefore be untestable in the unit suite, and the rule the founder
 * actually cares about — *"if there's only space for two, that's fine… then it says plus seven
 * more"* — would ship guarded by nothing. Widths come from the DOM; the DECISION comes from here,
 * where a test can hand it exact numbers.
 *
 * ══ NOT A FIXED COUNT ══════════════════════════════════════════════════════════════════════
 * The concierge column is resizable (`engine/columnResize.ts`), so a hard-coded pill count is right
 * at one width and wrong at every other. Same principle already settled for the peer-message
 * two-line clamp: measure at render.
 *
 * @param pillWidths   each pill's natural width, in order, px.
 * @param available    the row's usable width in px, label and all gaps to its right excluded.
 * @param moreWidth    width of the "+N more" affordance for a given overflow count. A FUNCTION
 *                     because "+7 more" and "+27 more" are not the same width, and rounding that
 *                     away is what makes a row wrap — the one thing the founder said it must not
 *                     do ("Now it'll all be on one row").
 * @param gap          horizontal gap between adjacent items, px.
 *
 * ALWAYS SHOWS AT LEAST ONE PILL when there is one. A row that rendered "Tasks: +9 more" and no
 * name at all would answer "is there structure here" while withholding the thing he asked for —
 * the NAMES. One ellipsised pill is strictly more information than none, and the overflow affordance
 * is still there to open the card.
 */
export function packPills(
  pillWidths: readonly number[],
  available: number,
  moreWidth: (overflow: number) => number,
  gap: number,
): PillPacking {
  const n = pillWidths.length;
  if (n === 0) return { shown: 0, overflow: 0 };

  // Everything fits: no overflow affordance is drawn, so it costs no width.
  // `noUncheckedIndexedAccess` is on, so an index read is `number | undefined`. A missing entry is
  // treated as a zero-width pill, which is the same degradation as an unmeasured one.
  const at = (i: number): number => pillWidths[i] ?? 0;

  let all = 0;
  for (let i = 0; i < n; i++) all += at(i) + (i > 0 ? gap : 0);
  if (all <= available) return { shown: n, overflow: 0 };

  // Otherwise every candidate k < n must also pay for its own "+N more".
  let used = 0;
  let best = 0;
  for (let k = 1; k < n; k++) {
    used += at(k - 1) + (k > 1 ? gap : 0);
    if (used + gap + moreWidth(n - k) <= available) best = k;
    else break; // widths are additive, so once it does not fit it never fits again.
  }

  const shown = Math.max(1, best);
  return { shown, overflow: n - shown };
}
