// durableBinding — the READ half of the orchestrator↔bead binding that outlives the roster row.
//
// ══ WHY THIS MODULE EXISTS ════════════════════════════════════════════════════════════════════
// `AgentTab.epicId` is THE BINDING (docs/orchestrators-per-task.md), and it lives in ONE window's
// localStorage. `stores/projectStore.removeAgent` destroys the row and TOMBSTONES its id, so the
// binding dies with it and no rehydrate brings it back. Bead `sparkle-n2feho.8` landed a durable
// RECORD of that binding — a `bd` comment on the bead — and roborev 80525 found it WRITE-ONLY:
// nothing in the app could read it back, which is the whole of the acceptance item
// `sparkle-n2feho.1` states as "the epic-orchestrator binding SURVIVES A FLEET REFRESH".
//
// This module is that reader, and the writer's own formatter, in one file.
//
// ══ IT IS A RECORD, NOT A SECOND MEMBERSHIP RULE ══════════════════════════════════════════════
// `scripts/lib/epic-membership-guard.sh` fails CI on a second definition of epic membership, and
// `docs/orchestrators-per-task.md` says the reuse predicate in `sendToBuild.prepareHandoff` and the
// reverse read in `planView.orchestratorNameForEpic` "must agree, and neither is duplicated
// anywhere else." So NOTHING here decides membership:
//
//   • The LIVE tier is not resolved here at all. The caller resolves it through
//     `planView.orchestratorForEpic` — the one existing reverse read — and hands the answer in.
//   • The DURABLE tier answers a strictly narrower question: "which agent, in which project, was
//     recorded as having been handed THIS BEAD, at a moment now past?" That is a fact about the
//     BEAD, written once and never re-decided. It cannot bind anything; it can only recall.
//
// ══ LIVE STRICTLY OUTRANKS DURABLE, AND THE COST FOLLOWS FROM IT ══════════════════════════════
// A live roster row means somebody is on this bead RIGHT NOW. A durable record means somebody was
// handed it and their row is GONE. Collapsing those two into one nullable name is what would make
// the feature actively harmful — a caller would resume, message or count an agent that does not
// exist. Hence the discriminated `source` and hence the precedence: when the live tier answers,
// this module performs NO read at all.
import { beadsDetail, type BeadComment } from "./beadsCommands";

/**
 * The machine-readable half of the handoff record.
 *
 * ══ WHY A TRAILER AND NOT JUST THE PROSE ══════════════════════════════════════════════════════
 * `sparkle-n2feho.8` wrote only an English sentence, which a human reads and a parser guesses at.
 * Founder decision 2026-09-04: make the record machine-readable. The prose STAYS — the thread is
 * read by people, and a bead comment that is only a JSON blob is a worse artifact — so the record
 * carries both, emitted by {@link handoffRecordComment} so the two can never disagree.
 *
 * ONE LINE, ALWAYS. `JSON.stringify` escapes every control character (a literal newline in an id
 * comes back as the two characters `\n`), so the trailer cannot be split across lines by its own
 * payload and {@link parseHandoffRecord}'s per-line scan cannot be desynchronised by a hostile id.
 */
export const BINDING_TRAILER_TAG = "sparkle:binding";

/** One recovered handoff record. `at` is null for a record written before the trailer existed —
 *  the prose form carries no timestamp, and inventing one would be a guess. */
export interface HandoffRecord {
  /** The internal `AgentTab.id` of the orchestrator, NOT its display name. */
  agentId: string;
  /** The Sparkle project id, NOT the repo root path. */
  projectId: string;
  /** The bead the orchestrator was handed. Absent from the prose form, where the caller's own bead
   *  id is the only answer available — see {@link parseHandoffRecord}. */
  beadId: string | null;
  /** Epoch ms the record was written; null when only the prose form was available. */
  at: number | null;
  /** Which arm answered. Exposed so a test can pin the precedence rather than infer it, and so a
   *  future migration can count how many pre-trailer records are still being read. */
  encoding: "trailer" | "prose";
}

/**
 * THE ONE FORMATTER — the prose sentence and the machine trailer, emitted together.
 *
 * Bead `sparkle-n2feho.9` requires that both encodings come out of a single function, because two
 * functions is how the sentence and the payload end up naming different agents. Everything the
 * parser can read is produced here; {@link parseHandoffRecord} is its exact inverse, pinned by a
 * round-trip test.
 *
 * The prose wording is UNCHANGED from what `sparkle-n2feho.8` shipped, deliberately: every record
 * already on `origin/main` has that exact shape, and the parser's fallback arm is keyed on it. Do
 * not reword it without also widening the fallback regex — and read
 * {@link parseHandoffRecord}'s note on why a reword is survivable now and was not before.
 */
export function handoffRecordComment(record: {
  agentId: string;
  projectId: string;
  beadId: string;
  at: number;
}): string {
  const prose =
    `Handed to Build: orchestrator \`${record.agentId}\` in project \`${record.projectId}\`. ` +
    `Recorded here because the binding itself (AgentTab.epicId) lives only in this window's ` +
    `local store — this comment is what survives a fleet refresh (bead sparkle-n2feho.8).`;
  // The key ORDER is fixed rather than left to object-literal chance: the trailer is the thing a
  // human skims in the bd thread, and a stable field order is what makes two of them comparable
  // by eye. `JSON.stringify` preserves insertion order for string keys.
  const trailer = `${BINDING_TRAILER_TAG} ${JSON.stringify({
    agentId: record.agentId,
    projectId: record.projectId,
    beadId: record.beadId,
    at: record.at,
  })}`;
  return `${prose}\n\n${trailer}`;
}

/** A non-empty string, or null. Used on every field the trailer's JSON hands back, because
 *  `JSON.parse` of attacker-shaped text yields `unknown`, not a `HandoffRecord`. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * The TRAILER arm — the machine record, if this comment carries one.
 *
 * Returns null rather than throwing on every malformed shape: a truncated line, a payload that is
 * not JSON, JSON that is not an object, an object missing `agentId` or `projectId`. A bead thread
 * is public writable state that any agent or human can append to, so "unparseable" is an ordinary
 * input here and must cost nothing.
 */
function trailerOf(text: string): HandoffRecord | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${BINDING_TRAILER_TAG} `)) continue;
    const payload = trimmed.slice(BINDING_TRAILER_TAG.length + 1).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const o = parsed as Record<string, unknown>;
    const agentId = str(o.agentId);
    const projectId = str(o.projectId);
    // BOTH are required. The pair IS the binding — "some agent somewhere was handed this" is the
    // one bit `HANDED_TO_BUILD_LABEL` already carries for free, so a half-record adds nothing and
    // returning it would let a caller render an empty project id as if it meant something.
    if (agentId === null || projectId === null) continue;
    return {
      agentId,
      projectId,
      beadId: str(o.beadId),
      at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : null,
      encoding: "trailer",
    };
  }
  return null;
}

/**
 * The PROSE arm — the pre-trailer form, and NOT an optional extra.
 *
 * Every record written before this bead landed has only the sentence. A parser that could not read
 * them would silently make every binding already on `origin/main` unrecoverable, which is the
 * failure this whole unit exists to remove — so this arm is load-bearing for the entire existing
 * corpus and is exercised by its own test.
 *
 * It carries NO bead id and NO timestamp, because the sentence never had them. Both come back null
 * rather than being fabricated from the surrounding comment's metadata: `BeadComment.createdAt` is
 * the comment's clock, not the handoff's, and the two differ whenever a record is copied forward.
 */
function proseOf(text: string): HandoffRecord | null {
  const m = /Handed to Build:\s*orchestrator\s+`([^`\n]+)`\s+in project\s+`([^`\n]+)`/.exec(text);
  if (!m) return null;
  const agentId = str(m[1]);
  const projectId = str(m[2]);
  if (agentId === null || projectId === null) return null;
  return { agentId, projectId, beadId: null, at: null, encoding: "prose" };
}

/**
 * Recover the handoff binding from a bead's comment thread, or null.
 *
 * PURE. Takes the comments and returns a value — no transport, no store, no clock — so the
 * precedence rules below are testable without a `bd` that answers on cue.
 *
 * ══ TWO PRECEDENCE RULES, AND THEY ARE DIFFERENT QUESTIONS ════════════════════════════════════
 *
 *   1. ACROSS comments: the NEWEST record wins. `BeadDetail.comments` is oldest-first
 *      (`beadsCommands.ts`), so this scans from the end. A RE-HANDOFF is an ordinary event —
 *      `prepareHandoff` re-stamps on every send and the label is idempotent — so a bead routinely
 *      carries several records, and the older ones name agents that were superseded. Taking the
 *      first match would recover the binding a re-handoff replaced.
 *
 *   2. WITHIN one comment: the TRAILER wins over the prose. They are written together and cannot
 *      normally disagree, but a comment is public writable text: a human quoting the sentence
 *      while editing the payload, or a reworded prose line beside an intact trailer, must resolve
 *      to the machine record. This is the arm that makes a REWORD survivable — before the trailer
 *      existed, changing that sentence broke every reader.
 *
 * A comment that yields neither is skipped, not fatal: the thread also holds ordinary human
 * conversation, and most comments on most beads are exactly that.
 */
export function parseHandoffRecord(comments: readonly BeadComment[]): HandoffRecord | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const text = comments[i]?.text;
    if (typeof text !== "string" || text === "") continue;
    // Rule 2, stated as one expression so a mutant that swaps the operands changes the ANSWER and
    // not merely the shape — `/mutation-check` cannot judge a precedence written across two
    // statements whose flipped form still parses to the same thing.
    const record = trailerOf(text) ?? proseOf(text);
    if (record) return record;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------------------------

/**
 * WHO IS — OR WAS — THE ORCHESTRATOR ON THIS BEAD.
 *
 * A DISCRIMINATED union, not a nullable name, and that is the point of the type. `source: "live"`
 * means a roster row exists and somebody is on this bead now; `source: "durable"` means the row is
 * GONE and all that survives is what the bead recorded. A caller that resumes, messages, counts or
 * bills the two identically is wrong in the second case, and a bare `string | null` gives it no way
 * to notice.
 */
export type OrchestratorBinding =
  | { source: "live"; agentId: string; name: string }
  | { source: "durable"; agentId: string; projectId: string; at: number | null };

/** The one seam. Injected so the reader is testable without tauri, and defaulted so production
 *  callers get the real transport without knowing it exists. NO new Rust and NO new IPC command:
 *  `beadsDetail` is the app's only comment READ and it already carries `--include-comments`. */
export interface DurableBindingDeps {
  readComments: (projectPath: string, beadId: string) => Promise<readonly BeadComment[]>;
}

export const durableBindingDeps: DurableBindingDeps = {
  readComments: async (projectPath, beadId) => (await beadsDetail(projectPath, beadId)).comments,
};

/**
 * Resolve the binding for ONE bead — live first, durable second, null last.
 *
 * ══ THE COST CONTRACT, WHICH IS ENFORCED BY THIS FUNCTION'S CONTROL FLOW ══════════════════════
 * `beads_detail` pulls a bead's WHOLE thread from a single-writer, contended Dolt store. Three
 * separate call sites (`BoardView`, `EpicInlineCard`, `Concierge/BeadPill`) document it as
 * PER-OPEN and refuse to put it on the board's 5s list poll. This function must never make that
 * refusal a lie, so it performs a read only when BOTH cheap gates fail:
 *
 *   • `live !== null` → answer from the roster. ZERO reads. This is the common case by a wide
 *     margin: an orchestrator that is running is a live row.
 *   • `handedToBuild === false` → answer null. ZERO reads. `HANDED_TO_BUILD_LABEL` rides on the
 *     bulk `listBeads` poll the caller ALREADY has in hand (`Bead.labels`), so this gate is free,
 *     and it is exact: the label and the comment are written by the same branch of
 *     `prepareHandoff`, so no bead can carry a record without carrying the label.
 *
 * A read therefore costs one detail call per bead that was PROVABLY handed to Build and whose
 * orchestrator row is PROVABLY gone — which is the recovery case itself, and nothing else.
 *
 * `live` is resolved by the CALLER, through `planView.orchestratorForEpic`. It is not resolved here
 * on purpose: that would be the second definition of the binding predicate the epic-membership
 * guard and `docs/orchestrators-per-task.md` both forbid.
 */
export async function resolveOrchestratorBinding(
  args: {
    projectPath: string;
    beadId: string;
    /** The live orchestrator, already resolved from the roster by the caller. */
    live: { id: string; name: string } | null;
    /** Does the bead carry `HANDED_TO_BUILD_LABEL`? From the polled snapshot; free. */
    handedToBuild: boolean;
  },
  deps: DurableBindingDeps = durableBindingDeps,
): Promise<OrchestratorBinding | null> {
  // LIVE WINS, and it wins BEFORE the read — so this line is both the precedence rule and the cost
  // rule, and a mutant that removes it is caught twice over (a wrong `source`, and a read that
  // should never have happened).
  if (args.live) return { source: "live", agentId: args.live.id, name: args.live.name };
  if (!args.handedToBuild) return null;
  let comments: readonly BeadComment[];
  try {
    comments = await deps.readComments(args.projectPath, args.beadId);
  } catch {
    // A FAILED READ IS NOT AN ABSENCE. It resolves to null the same way a bead with no record
    // does, because there is no honest third answer to give a caller here — but it must never
    // propagate, since the surfaces that call this (a plan read) have real work to return
    // alongside it and a recovery hint is not worth failing that.
    return null;
  }
  const record = parseHandoffRecord(comments);
  if (!record) return null;
  return {
    source: "durable",
    agentId: record.agentId,
    projectId: record.projectId,
    at: record.at,
  };
}
