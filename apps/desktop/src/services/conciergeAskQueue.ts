// THE ASK QUEUE'S IMPURE HALF — read the board, decide nothing, write what `@sparkle/core` decided.
//
// Every rule lives in `packages/core/conciergeAsks.ts` and is tested as data-in/data-out: what
// counts as an ask (`asksIn`), what it should become on the board (`planAsks`), how it is rendered
// back to the brain (`renderOpenAsks`). This file adds no policy. Its whole job is: gather the
// existing ask beads, call `planAsks`, obey the answer, and keep a synchronous cache the dispatch
// path can read without awaiting.
//
// Deliberately the same division `pusherRunner` draws, and for the same reason: a sweep that made
// decisions of its own would be the one part of the system not covered by pure tests.
//
// ── WHY THERE IS A CACHE AT ALL ─────────────────────────────────────────────────────────────────
// `buildSnapshot` runs on the dispatch path, which is synchronous by construction — the fleet
// picture is read at the moment the turn actually starts, so a queued question describes the app as
// it is rather than as it looked when it was typed. Reading `bd` there would put an IPC round-trip
// (and a `bd` process) in front of every turn. So the queue is refreshed on a slow poll and after
// every capture, and the dispatch path reads {@link openAsksNow} out of memory.
//
// THE CACHE FAILS TOWARDS SHOWING, NEVER TOWARDS SILENCE. If a refresh fails it keeps the previous
// answer rather than emptying: an unreadable board is "we could not look", and the one outcome this
// whole feature exists to eliminate is an ask quietly not being mentioned.
//
// ── WHERE ASKS ARE FILED, AND THE HONEST LIMITATION ─────────────────────────────────────────────
// READ across every project that has a beads database; WRITE to the pinned project (falling back to
// the first). The asymmetry is deliberate. The founder's asks are not project-scoped — "build ten
// homepage designs" and "give the concierge research agents" belong to two different repos — so a
// queue that only read one project would hide the very items that motivated it whenever the pin
// moved. Reading everywhere costs a handful of `bd list` calls on a slow poll and makes the pin
// irrelevant to whether he sees his own backlog.

import {
  ASK_LABEL,
  type AskBead,
  type AskRecord,
  type OpenAsk,
  askBeadBody,
  asksIn,
  planAsks,
  seenLabel,
  timesAskedOf,
} from "@sparkle/core";

import { createBead, labelBead, listBeads, type Bead } from "./beads";
import { log } from "../logger";

/** How often the queue re-reads the board. */
export const ASK_POLL_INTERVAL_MS = 60_000;

/** One project the queue can read from and write to. */
export interface AskProject {
  id: string;
  rootPath: string;
}

/** Everything this module needs from the world — injected so the policy above is testable. */
export interface AskQueueDeps {
  /** Every project, in the app's own order. */
  projects(): readonly AskProject[];
  /** The pinned project's id, or `null`. Writes go here when it names a real project. */
  pinnedProjectId(): string | null;
  listBeads(projectPath: string): Promise<Bead[]>;
  createBead(
    projectPath: string,
    title: string,
    body: string,
    labels?: string,
  ): Promise<string | null>;
  labelBead(
    projectPath: string,
    action: "add" | "remove",
    id: string,
    label: string,
  ): Promise<void>;
  now(): number;
}

const defaultDeps: Omit<AskQueueDeps, "projects" | "pinnedProjectId"> = {
  listBeads,
  createBead,
  labelBead,
  now: () => Date.now(),
};

/**
 * The last answer we got from the board.
 *
 * Module-level, like `conciergePromiseLedger`'s ledger, because there is exactly one queue per
 * window and threading it through the dispatch path would mean plumbing it through every caller of
 * `buildSnapshot`.
 */
let cache: OpenAsk[] = [];
let deps: AskQueueDeps | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The open asks, synchronously, for the dispatch path.
 *
 * Returns the last successful reading. Empty before the first refresh — which is honest: we have not
 * looked yet, and inventing rows would be worse than a first turn without them.
 */
export function openAsksNow(): readonly OpenAsk[] {
  return cache;
}

/** A bead is one of ours iff it carries the label. Body parsing decides the KEY, this decides scope. */
function isAskBead(b: Bead): boolean {
  return b.labels.includes(ASK_LABEL);
}

function toAskBead(b: Bead): AskBead {
  return {
    id: b.id,
    body: b.description,
    labels: b.labels,
    open: b.status !== "closed",
  };
}

/**
 * Read every project's ask beads.
 *
 * A project whose read FAILS is skipped rather than failing the sweep — one repo without `bd`
 * installed must not blank the queue for the others. It is logged, because "we could not look" is a
 * different fact from "there is nothing", and only the log preserves the difference.
 */
async function readAllAskBeads(
  d: AskQueueDeps,
): Promise<{ rows: Array<{ project: AskProject; bead: Bead }>; anyRead: boolean }> {
  const rows: Array<{ project: AskProject; bead: Bead }> = [];
  const projects = d.projects();
  let anyRead = false;
  for (const project of projects) {
    try {
      const beads = await d.listBeads(project.rootPath);
      anyRead = true;
      for (const bead of beads) if (isAskBead(bead)) rows.push({ project, bead });
    } catch (e) {
      log.debug("askQueue", `could not read beads for ${project.id}`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // NO PROJECTS IS A COMPLETE READING, NOT A FAILED ONE. Otherwise removing the last project would
  // pin the cache to whatever it last held, forever.
  return { rows, anyRead: anyRead || projects.length === 0 };
}

/** Where a newly captured ask is filed. Pinned project, else the first — see the header. */
function writeTarget(d: AskQueueDeps): AskProject | null {
  const projects = d.projects();
  const pinned = d.pinnedProjectId();
  return projects.find((p) => p.id === pinned) ?? projects[0] ?? null;
}

/**
 * A bead title is a scannable line, so it is his sentence trimmed — not a summary.
 *
 * Truncation is marked with an ellipsis so a reader can tell a shortened title from a short ask; the
 * full sentence is always in the body regardless.
 */
const TITLE_MAX = 80;
function titleOf(ask: AskRecord): string {
  const s = ask.sentence.trim();
  return s.length <= TITLE_MAX ? s : `${s.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/** Refresh {@link openAsksNow} from the board. Keeps the previous answer if the read yields nothing readable. */
export async function refreshOpenAsks(): Promise<readonly OpenAsk[]> {
  const d = deps;
  if (d === null) return cache;
  const { rows, anyRead } = await readAllAskBeads(d);
  // FAIL TOWARDS SHOWING (roborev 61877, High). This used to assign the mapped rows
  // unconditionally, so a sweep in which EVERY project read threw produced an empty list and
  // silently emptied the cache — the module's header promised the opposite in as many words, and
  // "we could not look" was being rendered as "you are owed nothing". `bd` failing fleet-wide is not
  // exotic: one unreadable store, a `bd` upgrade, or a locked DB does it to every project at once.
  // Keeping the previous answer can only ever show a stale ask, which he can close in a second;
  // blanking hides every ask he is owed, which is the whole defect this file exists to remove.
  if (!anyRead) return cache;
  cache = rows
    .filter((r) => r.bead.status !== "closed")
    .map((r) => ({
      beadId: r.bead.id,
      sentence: r.bead.title,
      timesAsked: timesAskedOf(r.bead.labels),
    }));
  return cache;
}

/** What a capture actually did, so the caller can tell the founder when something needs him. */
export interface AskCaptureOutcome {
  filed: Array<{ beadId: string; ask: AskRecord }>;
  bumped: Array<{ beadId: string; to: number }>;
  /** He asked again for something already closed — a disagreement worth surfacing. */
  reasked: Array<{ closedBeadId: string; beadId: string | null; ask: AskRecord }>;
  /**
   * The asks the cap withheld — the RECORDS, not a count. Never silently discarded, and never
   * merely counted either: the caller names them back to the founder, so he does not have to
   * reconstruct from memory what this app is still holding in a variable. See `MAX_ASKS_PER_MESSAGE`.
   */
  dropped: readonly AskRecord[];
}

/**
 * Capture everything the founder just asked for, and write it to the board.
 *
 * Safe to call and ignore: it never throws at the caller, because a failure to file must not also
 * break the turn he is in the middle of. A failure IS logged at warn — an ask we could not record
 * is the original bug, so it must not pass silently.
 */
export async function captureAsksFrom(
  text: string,
  turnId: string,
  cap?: number,
): Promise<AskCaptureOutcome> {
  const empty: AskCaptureOutcome = { filed: [], bumped: [], reasked: [], dropped: [] };
  const d = deps;
  if (d === null) return empty;

  try {
    // `cap` SCALES WITH THE RUN. A turn can answer several of his messages at once
    // (engine/conciergeTurnQueue), and they are captured in ONE call — `captureAsksFrom` reads the
    // whole board and then writes to it, so calling it per message would interleave N read-then-write
    // cycles and let two messages carrying the same ask each mint a bead. The cap is per MESSAGE, so
    // the caller passes MAX_ASKS_PER_MESSAGE × runLength and absorbing costs him no asks.
    const { asks, dropped } = asksIn(text, turnId, d.now(), cap);
    if (asks.length === 0) return { ...empty, dropped };

    const { rows, anyRead } = await readAllAskBeads(d);
    // A capture that could not read ANY board must not file: with no existing beads visible, every
    // ask looks new, so filing here would mint a duplicate of every open ask he happens to repeat.
    // Skipping loses nothing permanent — he is still in the conversation, and the next turn retries.
    if (!anyRead) return { ...empty, dropped };
    const plan = planAsks(asks, rows.map((r) => toAskBead(r.bead)));
    const byId = new Map(rows.map((r) => [r.bead.id, r.project] as const));
    const target = writeTarget(d);
    const outcome: AskCaptureOutcome = { filed: [], bumped: [], reasked: [], dropped };

    for (const ask of plan.create) {
      if (target === null) break;
      const id = await d.createBead(target.rootPath, titleOf(ask), askBeadBody(ask), ASK_LABEL);
      if (id !== null) outcome.filed.push({ beadId: id, ask });
    }

    for (const b of plan.bump) {
      const project = byId.get(b.beadId);
      if (project === undefined) continue;
      // Add the new rung BEFORE removing the old one. If the second call fails the bead still reads
      // as escalated; the other order would momentarily read as never-repeated, and a crash in the
      // gap would make it permanent.
      await d.labelBead(project.rootPath, "add", b.beadId, seenLabel(b.to));
      if (b.from > 1) {
        await d.labelBead(project.rootPath, "remove", b.beadId, seenLabel(b.from));
      }
      outcome.bumped.push({ beadId: b.beadId, to: b.to });
    }

    for (const r of plan.reasked) {
      if (target === null) break;
      const body = `${askBeadBody(r.ask)}\n\nHe asked for this again after ${r.closedBeadId} was closed.`;
      const id = await d.createBead(target.rootPath, titleOf(r.ask), body, ASK_LABEL);
      outcome.reasked.push({ closedBeadId: r.closedBeadId, beadId: id, ask: r.ask });
    }

    await refreshOpenAsks();
    return outcome;
  } catch (e) {
    log.warn("askQueue", "could not record what he asked for", {
      error: e instanceof Error ? e.message : String(e),
    });
    return empty;
  }
}

/** Wire the queue to the app and start its poll. Returns the teardown. */
export function startAskQueue(
  input: Pick<AskQueueDeps, "projects" | "pinnedProjectId"> & Partial<AskQueueDeps>,
): () => void {
  deps = { ...defaultDeps, ...input };
  void refreshOpenAsks();
  timer = setInterval(() => void refreshOpenAsks(), ASK_POLL_INTERVAL_MS);
  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    deps = null;
  };
}

/** Test seam — reset module state between cases. */
export function resetAskQueueForTest(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  deps = null;
  cache = [];
}
