// "Build It" — the handoff from a unit of work to an agent that builds it.
//
// ══ WHY THIS IS A HOOK AND NOT THREE HANDLERS ON A COMPONENT ═══════════════════════════════════
// These three actions lived inside `BoardView`'s `DetailOverlay` and nowhere else, which meant the
// board's expanded card could start work and the concierge's card could not — the founder asked for
// full action parity between the two, and the only honest way to get it is for both to call the
// SAME code. Copying the bodies would have delivered parity for one afternoon.
//
// ══ WHAT WAS DROPPED IN THE EXTRACTION, AND WHY ════════════════════════════════════════════════
// The presentation. `DetailOverlay` held `buildBusy`/`buildErr` in its own state and each handler
// set them; here the actions THROW, and whichever card renders them owns the busy flag and the
// error line. That is what lets one card serve two chromes without either of them inheriting the
// other's error placement — and it keeps the partial-batch sentence ("Started 2 of 5; the rest are
// untouched.") intact, because it travels as the thrown Error's message rather than as a setState.
//
// Everything else is carried across unchanged, including the two orderings that were review
// findings in their own right:
//
//   * The capacity PREFLIGHT runs BEFORE the claim. `claimBead` moves the bead to `in_progress`,
//     which on the board moves the card out of the column that renders the control at all — so
//     claiming and then failing hides the button the user just pressed (roborev 55139).
//   * `handleBuildAllPrd` preflights INSIDE the loop. The ceiling can be reached partway through a
//     batch, and claiming an epic that then cannot be handed off marks it in progress with no
//     orchestrator behind it. It stops cleanly and says how far it got.
import { useCallback, useMemo } from "react";
import {
  claimBead,
  epicIndexOf,
  isEpic,
  isEpicIndexed,
  STALLED_LABEL,
  type Bead,
  type EpicIndex,
} from "../../services/beads";
import { rollupEpicStatus } from "../../services/planView";
import { useBeadsStore } from "../../stores/beadsStore";
import { parsePrdRef } from "../../services/tasks";
import { sendToBuild, sendToBuildBlockedReason } from "../../services/sendToBuild";
import { useProjectStore } from "../../stores/projectStore";

export interface BeadBuildActions {
  /** The PRD this epic's body names, or null for a PRD-less epic (the handoff seeds off the bead). */
  prdPath: string | null;
  /**
   * The STARTABLE epics sharing this PRD — including this bead when it is itself one of them, and
   * excluding it when it is not. `<= 1` means there is no batch to offer.
   *
   * Both halves of that sentence used to be stated more loosely ("sibling epics… INCLUDING this
   * one", "populated for ANY bead whose body links a PRD") and both stopped being true when the
   * list began filtering on {@link isStartable}: the pressed bead drops out when it is stalled,
   * blocked, closed or rolled-up-done, and the list is EMPTY for a PRD whose epics are all
   * unstartable (roborev 65617).
   *
   * That matters beyond accuracy, because the looser claim was the stated reason
   * {@link buildAllPrd}'s `epic` gate stays mutation-testable. The narrower condition that actually
   * holds — and the one a future change must preserve — is: a PRD-linked NON-EPIC whose PRD has two
   * or more STARTABLE epics still resolves a non-empty list, which is the state in which `epic &&`
   * is observable. `useBeadBuildActions.test.ts` feeds exactly that.
   */
  prdEpics: Bead[];
  /** Claim this epic and hand it to the Build orchestrator, which fans one worker out per child. */
  buildEpic: () => Promise<void>;
  /** Claim this bead and build it on ONE isolated worker branch — no fan-out. */
  buildTask: () => Promise<void>;
  /**
   * Claim and hand off every epic that shares this PRD, in turn — or NULL when this bead is not an
   * epic, or is the only epic in its PRD.
   *
   * ══ THE EPIC GATE LIVES HERE, NOT AT THE CALL SITES ═════════════════════════════════════════
   * `prdPath` is parsed out of THIS bead's description, and `parsePrdRef` matches a `PRD file:`
   * line in any body regardless of type. So a task or bug carrying a PRD back-link resolves a
   * non-empty `prdEpics`, and a caller gating only on `prdEpics.length > 1` offers "Build all N
   * epics in this PRD" on a card for a bead that is not one of them — one press claiming and
   * handing off every epic in that PRD. Both surfaces made exactly that mistake independently
   * (roborev on BeadPill, then again on BoardView), which is the signal the gate belongs to the
   * shared hook rather than to whoever renders it.
   *
   * That non-emptiness is deliberately PRESERVED rather than optimised away — it is the only state
   * in which the `epic` condition below can be observed doing anything, so removing it would leave
   * the gate green under deletion. See the `prdEpics` note in the body.
   */
  buildAllPrd: (() => Promise<void>) | null;
  /**
   * `buildEpic` for an epic, `buildTask` for every other bead, and NULL once the bead has been
   * started or closed — the caller does not re-derive either half.
   *
   * The null is a RENDER instruction as much as a capability one: each surface treats it as "show
   * no Build It", which is what makes the board card, the detail overlay and the concierge card
   * agree without any of them knowing the rule. See `startable` in the body for why the gate is
   * the bead's status and not the board column it happens to be drawn in.
   */
  buildIt: (() => Promise<void>) | null;
}

/**
 * The build actions for one bead.
 *
 * `rootPath` is looked up from the project store rather than taken as a prop, exactly as
 * `DetailOverlay` did: the surfaces that render this hold a `projectId` and would each have to do
 * the same lookup. A project that is not in the store yields `null`, and — again matching the
 * original — the claim is then SKIPPED while the handoff still runs, because `sendToBuild` throws
 * its own error for an unknown project and that is the more specific complaint.
 */
/**
 * `board.blocked`'s ids, cached on the ARRAY'S identity.
 *
 * The board card mounts this hook once per card and the Backlog column renders every card, so a
 * per-card `.some()` over the blocked lane would be O(cards × blocked). `beadsStore` preserves the
 * snapshot's array identity across a poll that changed nothing (`snapshotUnchanged`), so keying a
 * WeakMap on it builds ONE Set per real change and every card after that reads it in O(1).
 */
/*
 * ══ THE EPIC INDEX IS `beads.ts`'s, NOT A SECOND COPY ════════════════════════════════════════════
 * This file used to keep its OWN `WeakMap<readonly Bead[], EpicIndex>` over `buildEpicIndex`. That
 * was correct in isolation and wrong once `main` deleted the column+type gate on the `StartControls`
 * render site: the hook now mounts on EVERY card, beside `Card`/`DetailOverlay`, which resolve the
 * same questions through `beads.ts`'s `epicIndexOf`. Two caches keyed on the SAME `allBeads` array
 * meant two full O(n) builds per snapshot — 6-13 ms each on the founder's 7,364-bead store, on the
 * exact render path the index exists to make cheap. `beads.ts` says so at the export verbatim
 * (roborev 65596), and this is the caller it was warning about.
 *
 * Worse than the double build, the two disagreed on STALENESS: `beads.ts` stores `beads.length`
 * beside the index and rebuilds when it moves, this one did not — so an in-place `push` left the
 * hook's `isStartable`/`prdEpicsByPath` answering from a stale index while the card beside it
 * answered from a fresh one. That is the silent-merge shape AGENTS.md warns about: git took both
 * sides cleanly and left a caller reading the retired source (roborev 65768).
 *
 * So: import `epicIndexOf` and use it everywhere. One build per snapshot, and one staleness
 * contract for the EPIC INDEX across all three Build It surfaces. `buildEpicIndex` stays public for
 * callers that genuinely want a fresh, uncached build — this is not one of them.
 *
 * That sentence used to say "across all three Build It surfaces" without the qualifier, and it was
 * false inside this very file: `prdEpicsByPath` cached on the bead ARRAY, unguarded, so the same
 * in-place push the fix handles left `startable` fresh and `prdEpics` stale — the identical
 * disagreement one scope down (roborev 65775). It is keyed on the INDEX now; see there. The one
 * remaining identity-only cache is {@link blockedIdsOf}, and it is keyed on a DIFFERENT array (the
 * store's `board.blocked` lane, not `allBeads`), so `epicIndexOf`'s guard could not cover it
 * anyway — it relies on the fresh-array-per-snapshot contract `beadsStore` actually keeps.
 */

/**
 * Epics grouped by the PRD their body links, cached on the {@link EpicIndex} `epicIndexOf` hands
 * back for this snapshot — NOT on the bead array.
 *
 * ══ KEYED ON THE INDEX SO THE STALENESS CONTRACT COMES FOR FREE ══════════════════════════════
 * This was a `WeakMap<readonly Bead[], …>` with no length guard, which made it the sibling of the
 * bug one scope up: an in-place `push` keeps the array's identity, so `startable` re-read a rebuilt
 * index and offered Build It on the pushed epic while this map answered from the RETIRED one —
 * `prdEpics` omitting it, and `buildAllPrd` collapsing to `null` or under-counting "Build all N
 * epics in this PRD" (roborev 65775).
 *
 * Keying on the index object rather than duplicating its `{ value, length }` guard means there is
 * exactly ONE place that decides when a snapshot is stale. A rebuilt index is a new object, so this
 * map misses and regroups; an unchanged one is the same object, so it hits. The derived cache
 * cannot drift from its source because it is no longer deciding anything.
 *
 * ══ CACHING THE INDEX WAS ONLY HALF THE FIX ══════════════════════════════════════════════════
 * Sharing {@link epicIndexOf} removed the per-card `isEpic` walk, but the `filter` that consumed
 * it was still O(backlog) PER CARD — and it ran `parsePrdRef`, a multiline regex, over every bead's
 * full description. On a Backlog column that renders all ~1,600 cards that is
 * `cards_with_a_PRD_link × 2,100` regex executions on every `allBeads` identity change: the exact
 * per-card-whole-backlog shape the other two caches exist to remove (roborev 65609).
 *
 * Grouping once per bead-list identity turns the per-card cost into a single map lookup. The result
 * is byte-identical — same beads, same input order — so `prdEpics` stays non-empty for a PRD-linked
 * task and `buildAllPrd`'s `epic &&` gate remains mutation-testable, which is what job 65605 was
 * about. The startable filter is applied to the LOOKUP, not folded in here: it depends on the
 * blocked lane as well as the bead list, and the group it filters is a handful of epics rather than
 * the whole store.
 */
const PRD_EPICS = new WeakMap<EpicIndex, ReadonlyMap<string, Bead[]>>();
function prdEpicsByPath(beads: readonly Bead[]): ReadonlyMap<string, Bead[]> {
  const index = epicIndexOf(beads);
  const hit = PRD_EPICS.get(index);
  if (hit) return hit;
  const out = new Map<string, Bead[]>();
  for (const b of beads) {
    if (!isEpicIndexed(index, b)) continue;
    const path = parsePrdRef(b.description)?.relPath;
    if (!path) continue;
    const bucket = out.get(path);
    if (bucket) bucket.push(b);
    else out.set(path, [b]);
  }
  PRD_EPICS.set(index, out);
  return out;
}

/** One frozen empty array, so a miss does not mint a new reference on every render. */
const NO_EPICS: Bead[] = [];

const BLOCKED_IDS = new WeakMap<readonly Bead[], ReadonlySet<string>>();
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
function blockedIdsOf(blocked: readonly Bead[] | undefined): ReadonlySet<string> {
  if (!blocked) return EMPTY_IDS;
  const hit = BLOCKED_IDS.get(blocked);
  if (hit) return hit;
  const ids = new Set(blocked.map((b) => b.id));
  BLOCKED_IDS.set(blocked, ids);
  return ids;
}

/**
 * Has this bead not been started yet — the ONE question all three Build It surfaces ask.
 *
 * ══ WHY IT IS THE BEAD'S OWN STATE AND NOT THE COLUMN IT IS DRAWN IN ═══════════════════════════
 * The founder's ask arrived truncated — "if it is in a backlog state, I should be able to click
 * the" — and he confirmed it: Build It, on a backlog bead, offered "only before work starts".
 *
 * It must read off the BEAD, because two of the three surfaces have no column to read: the detail
 * overlay is a dialog and the concierge's `BeadPill` is a card in a chat thread. A column-shaped
 * rule is enforceable only on the board card — which is precisely how the two gates came to
 * disagree. The card checked `columnKey === "backlog" || "planning"`; the overlay and the concierge
 * checked nothing at all and offered Build It on work already in progress.
 *
 * ══ "OPEN" IS NECESSARY, NOT SUFFICIENT — THREE LANES ARE OPEN AND UNSTARTABLE ═════════════════
 * The first draft gated on `status === "open"` alone and shipped all three as pressable
 * (roborev 65604). The old column gate had excluded two of them BY ACCIDENT — it named two columns,
 * so `blocked` fell outside it without anyone deciding that — and a status rule opted them back in.
 *
 *   * DEPENDENCY-BLOCKED / STALLED. `beads.columnFor` files an open bead into `blocked` on an unmet
 *     bd dependency OR a {@link STALLED_LABEL}, so the blocked lane covers both.
 *     `sendToBuildBlockedReason` checks only agent-slot capacity — it knows nothing about either —
 *     so nothing downstream would refuse the press. The label is ALSO checked directly, so the rule
 *     still holds on a surface whose board snapshot has not loaded yet.
 *   * AN EPIC WHOSE CHILDREN HAVE ALL CLOSED. `epicBoard.openEpicStage` files it under Done —
 *     finished work whose epic bead nobody closed. Pressing there claims a completed epic to
 *     `in_progress` and spawns an orchestrator against nothing.
 *
 * A REFUSAL HERE OWES THE USER AN EXIT, and for a stalled epic that exit is load-bearing: the sweep
 * writes {@link STALLED_LABEL} to mean "we spent this epic's restart and it bought nothing; wait for
 * the human", and `beads.ts` names being "picked up" as one of only three ways back. Build It IS
 * that pickup. So `StartControls` renders its click-to-clear badges — including one for this label
 * — whether or not the button is offered, rather than returning early and taking the remedy with it
 * (roborev 65607).
 *
 * Takes the prebuilt {@link EpicIndex} rather than the bead list so it is O(1): the PRD batch calls
 * it once per sibling, and re-deriving children per call would put back the O(n²) the index removed.
 */
export function isStartable(
  bead: Bead,
  index: EpicIndex,
  blockedIds: ReadonlySet<string>,
): boolean {
  if (bead.status !== "open") return false;
  if (bead.labels.includes(STALLED_LABEL)) return false;
  if (blockedIds.has(bead.id)) return false;
  if (
    isEpicIndexed(index, bead) &&
    rollupEpicStatus(index.statusesByParent.get(bead.id) ?? []) === "done"
  ) {
    return false;
  }
  return true;
}

export function useBeadBuildActions({
  bead,
  projectId,
  allBeads,
  onStarted,
}: {
  bead: Bead;
  projectId: string;
  /** Every bead in the project — read to find the epics that share this one's PRD. */
  allBeads: readonly Bead[];
  /** Ran after a handoff lands. The board closed its overlay here; the concierge closes its card. */
  onStarted?: () => void;
}): BeadBuildActions {
  const rootPath = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.rootPath ?? null,
  );
  // Hoisted above `prdEpics`, which filters on it. The blocked lane is read from the board snapshot
  // rather than passed in, so all three surfaces get the rule without each doing the lookup.
  const blockedIds = blockedIdsOf(
    useBeadsStore((st) => st.byProject[projectId]?.board.blocked),
  );

  const prdPath = useMemo(() => parsePrdRef(bead.description)?.relPath ?? null, [bead.description]);
  // MEMOIZED, and it did not used to be — the two reads in the returned object below each called
  // `isEpic`, which runs `childrenOf`: a `filter` that both scans AND ALLOCATES over the project's
  // entire backlog. Two whole-backlog scans per render was affordable while at most one card was
  // ever mounted (a board overlay, or a concierge card the reader had clicked open).
  //
  // IT STOPPED BEING AT MOST ONE. Bead cards now render expanded by default in the concierge
  // (`[ui].bead_cards_expanded`), and `ConciergeThread` is NOT virtualized — it renders every
  // visible message — so the mounted-card count went from 0-1 to "every resolvable bead id in the
  // thread", which the founder's own habit of listing eight or more per reply makes concrete
  // (roborev 65335). At that width the repetition is the part that bites: 2 × O(backlog) × cards,
  // re-run on every store tick that repaints the thread. One memo takes the 2 to 1 and the
  // per-render to per-`allBeads`-change.
  //
  // Keyed on `bead.id`/`bead.type` rather than on `bead`, whose identity changes on every poll even
  // when the row came back byte-identical — those are the only two fields `isEpic` reads.
  const epic = useMemo(
    () => isEpic(allBeads, bead),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `isEpic` reads only these two fields
    [allBeads, bead.id, bead.type],
  );
  // ══ A MAP LOOKUP, NOT A WHOLE-BACKLOG WALK ══════════════════════════════════════════════════
  // See {@link prdEpicsByPath} for why this is grouped once per bead-list identity rather than
  // filtered per card, and why the result is deliberately NOT narrowed to epics-only-when-this-
  // bead-is-an-epic (that short-circuit made `buildAllPrd`'s `epic &&` gate untestable — job
  // 65605). The startable filter runs here rather than in the cache because it also depends on the
  // blocked lane, and by this point it is filtering a handful of epics, not the store.
  const byPath = prdEpicsByPath(allBeads);
  const prdEpics = useMemo(() => {
    if (prdPath === null) return NO_EPICS;
    // FILTERED ON THE SAME PREDICATE THE CARD USES, so the count and the loop agree. Without it the
    // batch was a hole straight through the three exclusions: `buildAllPrd` claims and hands off
    // every entry here, so a stalled, dependency-blocked or already-finished sibling was started by
    // one press on a DIFFERENT epic's card (roborev 65607).
    const group = byPath.get(prdPath);
    if (!group) return NO_EPICS;
    return group.filter((b) => isStartable(b, epicIndexOf(allBeads), blockedIds));
  }, [byPath, allBeads, prdPath, blockedIds]);

  // ══ THE GATE IS THE BEAD'S OWN STATE, NOT THE COLUMN IT IS DRAWN IN ══════════════════════════
  // The founder's ask arrived truncated — "if it is in a backlog state, I should be able to click
  // the" — and he confirmed it: Build It, on a backlog bead, offered "only before work starts".
  //
  // It has to be read off the BEAD rather than off the board column, because two of the three
  // surfaces that render this hook have no column to read: the detail overlay is a dialog, and the
  // concierge's `BeadPill` is a card in a chat thread. A column-shaped rule can only ever be
  // enforced on the board card — which is precisely how the two gates came to disagree. The card
  // checked `columnKey === "backlog" || "planning"`; the overlay and the concierge checked nothing
  // at all and offered Build It on work already in progress.
  //
  // `status === "open"` is that intent in the one vocabulary all three share: `in_progress` is work
  // already handed to an agent (handing it over twice is the mistake this closes) and `closed` is
  // finished. It is deliberately NOT the same as "sits in the ladder's Backlog column":
  // `epicBoard.openEpicStage` files a status-`open` epic under Planning, Building or Done from its
  // CHILDREN's roll-up. Planning is startable and always was. Building is the one widening, and it
  // is safe by construction — `sendToBuild` reuses the orchestrator already bound to that epic
  // ("ONE ORCHESTRATOR PER EPIC"), so a press there re-opens the existing agent instead of
  // spawning a second one against the same work.
  //
  // ══ "OPEN" ALONE IS TOO WIDE — SEE {@link isStartable} ═══════════════════════════════════════
  // `status === "open"` is necessary but not sufficient; the predicate below says why, and it is a
  // FUNCTION rather than an inline expression because the PRD batch has to ask it too. Gating only
  // the pressed bead left `buildAllPrd` claiming every sibling in `prdEpics` regardless — one press
  // reopening a CLOSED epic to `in_progress` with an orchestrator against finished work
  // (roborev 65607).
  const startable = isStartable(bead, epicIndexOf(allBeads), blockedIds);

  const buildOne = useCallback(
    async (mode: "epic" | "task") => {
      const blocked = sendToBuildBlockedReason(projectId, bead.id, mode);
      if (blocked) throw new Error(blocked);
      if (rootPath) await claimBead(rootPath, bead.id);
      sendToBuild({ projectId, epicId: bead.id, prdPath, mode });
      onStarted?.();
    },
    [projectId, bead.id, rootPath, prdPath, onStarted],
  );

  const buildEpic = useCallback(() => buildOne("epic"), [buildOne]);
  const buildTask = useCallback(() => buildOne("task"), [buildOne]);

  const buildAllPrd = useCallback(async () => {
    let built = 0;
    for (const epic of prdEpics) {
      const blocked = sendToBuildBlockedReason(projectId, epic.id);
      if (blocked) {
        throw new Error(`${blocked} Started ${built} of ${prdEpics.length}; the rest are untouched.`);
      }
      if (rootPath) await claimBead(rootPath, epic.id);
      sendToBuild({ projectId, epicId: epic.id, prdPath });
      built += 1;
    }
    onStarted?.();
  }, [prdEpics, projectId, rootPath, prdPath, onStarted]);

  return {
    prdPath,
    prdEpics,
    buildEpic,
    buildTask,
    // BOTH conditions, here rather than at each call site — see the interface note. A non-epic with
    // a PRD back-link in its body resolves a non-empty `prdEpics`, so `length > 1` alone is not a
    // gate; and one epic in its own PRD is not a batch.
    //
    // ...AND the same `startable` gate as `buildIt` below. A card that has hidden "Build It"
    // because the work is already running must not still offer "Build all 5 epics in this PRD" —
    // that is the louder button of the two, and one press claims and hands off every epic in the
    // PRD. The two controls answer to one rule or the card contradicts itself.
    buildAllPrd: epic && startable && prdEpics.length > 1 ? buildAllPrd : null,
    // ══ WHO GETS "BUILD IT" — A DECISION THE FOUNDER MADE, NOT A DEFAULT ═════════════════════
    // This read `epic ? buildEpic : bead.type === "task" ? buildTask : null`, and that `task`
    // fallback carried a deliberate comment: it is "a TYPE question — is this a single unit of
    // work I can hand to one agent". The question was real. The answer had a cost nobody had
    // measured: of 2,074 open beads, 1,753 — including ALL 1,652 bugs and all 95 features — had no
    // Build It on ANY surface, so the button read as broken rather than as withheld.
    //
    // Put to the founder as a choice (offer it on everything / on bug+feature but not chore / keep
    // the gate and explain the absence), he chose EVERY OPEN BEAD. So the type gate is gone, and a
    // thin brief is the accepted cost — the agent asks rather than the board refusing. Nothing in
    // the machinery ever needed the type: `sendToBuild`'s "task"-mode seed prompt is already
    // type-agnostic ("Build bead X (a single task). Run `bd show X` to read it…"). Only the gate
    // was.
    //
    // `startable` replaces it and asks a DIFFERENT question — not "is this the kind of thing an
    // agent can build" but "has anyone started it yet".
    buildIt: startable ? (epic ? buildEpic : buildTask) : null,
  };
}
