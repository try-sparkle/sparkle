// The BOARD domain — the concierge's access to the work graph.
//
// WHY THIS IS ONE DOMAIN AND NOT TWO. The PRD asks for a "board" surface (section B) and a "beads"
// surface (section G) as separate items. They are the same store: the Tasks board IS `bd`, bucketed
// by `services/beads.bucketBeads`. Shipping two domains over one store would give the model two
// vocabularies for the same rows and guarantee they drift, so this domain answers both shapes —
// `list_items` returns the graph, `get_board` returns it bucketed into the columns the human sees.
//
// EVERY OP TAKES A projectPath. Beads are per-repo (`bd` resolves a workspace from a path), so there
// is no "the" board — the registry resolves the project and hands us `rootPath`.
//
// The registry treats READS and WRITES differently when resolving that project, and the asymmetry
// is stated there rather than here: a read may fall back to the selected project, a write must be
// given one explicitly (an ask-tier `delete_item` approval is fingerprinted over the model's raw
// arguments, so a write naming no project could be performed against a different one on the retry
// turn). Nothing in THIS module depends on which happened — it is handed a path either way.
//
// BEADS ARE OPTIONAL. A project with no `bd` database is a NORMAL, supported state (see
// buildAgentSpawn's auto-bead, which deliberately swallows it). So every op here converts a missing
// workspace / missing binary into an honest refusal — `beads-unavailable` — rather than an
// internal-error. The concierge can then tell the human "this project has no beads database"
// instead of reporting a bug that isn't one.
import {
  listBeads,
  beadShow,
  blockedBeadIds,
  claimBead,
  closeBead,
  labelBead,
  setBeadPriority,
  deleteBead,
  bucketBeads,
  columnFor,
  childrenOf,
  isEpic,
  isBeadsUnavailable,
  type Bead,
} from "../beads";
// The COMMENT half comes from `services/beadsCommands` rather than `services/beads`, and the split
// is not arbitrary. `beads.ts` is the board's rendering path: it has a comment WRITE
// (`commentBead`) and no comment READ at all, and its write goes through `notes.rs::bead_comment`,
// which reports success without reading the row back. `beadsCommands.ts` is the programmatic
// seam — bounded output, typed errors — and it already carries BOTH halves: `beadsComment` writes
// (via `beads_cmd.rs::comment_bead`) and `beadsDetail` returns the thread. Using it means this
// domain adds no new IPC command and no new Rust.
//
// The cost of crossing seams is that its rejection is a STRUCTURED `BeadsError` object, not an
// `Error` — so `attempt`'s `String(e)` would have produced the literal "[object Object]" as a
// refusal message. `isBeadsError` below is what keeps that from happening.
import {
  beadsComment,
  beadsCreate,
  beadsDetail,
  isBeadsError,
  type BeadComment,
  type BeadsError,
} from "../beadsCommands";
// THE EPIC GATE (bead `sparkle-xelans.3`). Both modules are PURE — the parser reads the model's
// answer, the scorer ranks what `services/beads`' one epic resolver hands it — so this file stays
// the only place that touches the store.
import {
  EPIC_DECISION_SYNTAX,
  formatEpicDecisionComment,
  parseEpicDecision,
  type EpicDecision,
} from "./epicDecision";
import { candidateEpics, describeCandidates, type EpicCandidate } from "./epicCandidates";
// THE CLASSIFY STEP (bead `sparkle-o05vcs.2`) — a DIFFERENT question from the gate above. The gate
// asks "which EXISTING epic does this task go under"; this asks "is this ask a task or an epic AT
// ALL". It is a written rule with stable ids, not a model call, and it takes NO new argument: the
// only inputs are the `title` and `body` `create_item` already has, so the concierge cannot skip it
// by omitting a field. What it produces is recorded on the bead beside the epic decision, because
// "record WHICH rule fired, so a wrong call is arguable later instead of mysterious" is the whole
// requirement — a verdict without the rule id satisfies none of it.
import {
  classifyAsk,
  formatAskClassificationComment,
  type AskClassification,
} from "../../engine/askClassification";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

export const BOARD_OPS = [
  "list_items",
  "get_item",
  "get_board",
  "ready_items",
  "blocked_items",
  "list_comments",
  "create_item",
  "update_item",
  "comment_item",
  "delete_item",
] as const;

export type BoardOp = (typeof BOARD_OPS)[number];

export type BoardRisk = "read-only" | "routine" | "disruptive" | "irreversible";

/**
 * EXHAUSTIVE by construction — `Record<BoardOp, BoardRisk>`, so an op added to `BOARD_OPS` without a
 * classification fails `tsc` rather than defaulting to something permissive.
 *
 * `delete_item` is `irreversible`, not `disruptive`: it wraps `bd delete --force`, which destroys the
 * row outright. Closing a bead is recoverable (reopen it); deleting one is not. `create_item` and
 * `update_item` are `routine` — they are the ordinary bookkeeping the concierge exists to do, and
 * gating them behind an approval would mean the human files their own tasks, which is the exact
 * round-trip this PRD removes.
 */
export const BOARD_RISK: Record<BoardOp, BoardRisk> = {
  list_items: "read-only",
  get_item: "read-only",
  get_board: "read-only",
  ready_items: "read-only",
  blocked_items: "read-only",
  list_comments: "read-only",
  create_item: "routine",
  update_item: "routine",
  // APPEND-ONLY, and that is what makes it `routine` rather than `disruptive`. A comment cannot
  // overwrite anything — not the body, not an earlier comment — so the worst a wrong one does is
  // add a line somebody has to read. Compare `update_item`, which is also routine and CAN change a
  // status. The one thing it shares with `create_item` is that it has no idempotency key: a retry
  // after a lost ack appends a SECOND copy, which is why mcp-control bounds it like a create.
  comment_item: "routine",
  delete_item: "irreversible",
};

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export interface BoardOk<T> {
  ok: true;
  op: BoardOp;
  risk: BoardRisk;
  data: T;
}

export interface BoardRefusal {
  ok: false;
  op: BoardOp;
  risk: BoardRisk;
  reason: string;
  message: string;
}

export type BoardResult<T> = BoardOk<T> | BoardRefusal;

function ok<T>(op: BoardOp, data: T): BoardOk<T> {
  return { ok: true, op, risk: BOARD_RISK[op], data };
}

function refuse(op: BoardOp, reason: string, message: string): BoardRefusal {
  return { ok: false, op, risk: BOARD_RISK[op], reason, message };
}

/**
 * Run a `bd`-backed operation, converting the two failure modes that are NOT bugs into refusals.
 *
 * `isBeadsUnavailable` covers both "this repo has no beads workspace" and "the `bd` binary isn't
 * installed" — neither is an error state for Sparkle, and reporting them as `internal-error` would
 * send the concierge hunting a crash. Anything else genuinely is unexpected and keeps its message.
 */
async function attempt<T>(op: BoardOp, run: () => Promise<T>): Promise<BoardResult<T>> {
  try {
    return ok(op, await run());
  } catch (e) {
    // The TYPED rejection first — a `BeadsError` is a plain object, so every test below it
    // (`instanceof Error`, `String(e)`) reads it as "[object Object]" and loses the whole message.
    if (isBeadsError(e)) return fromBeadsError(op, e);
    if (isBeadsUnavailable(e)) return unavailable(op);
    return refuse(op, "beads-failed", e instanceof Error ? e.message : String(e));
  }
}

/** The one wording for "this project has no work graph", shared by both rejection shapes so the two
 *  seams cannot drift into two different explanations of the same normal state. */
function unavailable(op: BoardOp): BoardRefusal {
  return refuse(
    op,
    "beads-unavailable",
    "This project doesn't have a beads database (or `bd` isn't installed), so it has no work " +
      "graph for me to read. Run `bd init` in the project to start one.",
  );
}

/**
 * Map `beadsCommands`' closed error union onto this domain's refusal vocabulary.
 *
 * Only two kinds are the not-a-bug case `attempt` already had a word for: `noWorkspace` (never ran
 * `bd init`) and `binaryNotFound` (bd isn't installed) — the same two facts `isBeadsUnavailable`
 * substring-matches on the other seam. Everything else is a real failure and keeps its own message,
 * which is strictly better than the substring path could manage: `storeBusy` and `timeout` are the
 * contended-Dolt-lock cases this repo hits constantly, and telling the concierge "bd was busy" is
 * what lets it retry rather than report the project as beadless.
 */
function fromBeadsError(op: BoardOp, e: BeadsError): BoardRefusal {
  if (e.kind === "noWorkspace" || e.kind === "binaryNotFound") return unavailable(op);
  return refuse(op, "beads-failed", e.message);
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

/** One item as the concierge sees it: the bead plus the two facts the raw row does not carry — which
 *  board column it lands in, and whether a dependency is holding it. */
export interface BoardItemView extends Bead {
  column: ReturnType<typeof columnFor>;
  blocked: boolean;
}

function viewOf(bead: Bead, blocked: ReadonlySet<string>): BoardItemView {
  return { ...bead, column: columnFor(bead, blocked), blocked: blocked.has(bead.id) };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** Every item in the project's work graph, each tagged with its column and blocked state. */
export async function listItems(projectPath: string): Promise<BoardResult<BoardItemView[]>> {
  return attempt("list_items", async () => {
    const [beads, blocked] = await Promise.all([
      listBeads(projectPath),
      blockedBeadIds(projectPath),
    ]);
    return beads.map((b) => viewOf(b, blocked));
  });
}

/** One item, with its children — so "what is this epic made of" is a single call, not N+1. */
export async function getItem(
  projectPath: string,
  id: string,
): Promise<BoardResult<{ item: BoardItemView; children: BoardItemView[] } | null>> {
  return attempt("get_item", async () => {
    const [bead, beads, blocked] = await Promise.all([
      beadShow(projectPath, id),
      listBeads(projectPath),
      blockedBeadIds(projectPath),
    ]);
    if (!bead) return null;
    return {
      item: viewOf(bead, blocked),
      children: childrenOf(beads, id).map((c) => viewOf(c, blocked)),
    };
  });
}

/** The board exactly as the human's Tasks view buckets it. */
export async function getBoard(projectPath: string) {
  return attempt("get_board", async () => {
    const [beads, blocked] = await Promise.all([
      listBeads(projectPath),
      blockedBeadIds(projectPath),
    ]);
    return bucketBeads(beads, blocked);
  });
}

/**
 * The two lanes, derived from `columnFor` rather than re-filtered by hand.
 *
 * They MUST agree with the board: `columnFor` treats `in_progress` as neither `backlog` nor
 * `blocked` (it is its own lane), so a `status !== "closed"` filter would put claimed work in both.
 * That matters concretely — `ready_items` answers "what can I start", and returning a bead someone
 * is already on invites a second agent onto the same task. Deriving from `columnFor` makes the
 * disagreement impossible instead of merely fixed once.
 */
async function laneOf(
  op: BoardOp,
  projectPath: string,
  lane: ReturnType<typeof columnFor>,
): Promise<BoardResult<BoardItemView[]>> {
  return attempt(op, async () => {
    const [beads, blocked] = await Promise.all([
      listBeads(projectPath),
      blockedBeadIds(projectPath),
    ]);
    return beads.map((b) => viewOf(b, blocked)).filter((v) => v.column === lane);
  });
}

/** Work with nothing holding it and nobody on it — the "what can I start right now" query. */
export async function readyItems(projectPath: string): Promise<BoardResult<BoardItemView[]>> {
  return laneOf("ready_items", projectPath, "backlog");
}

/** Open work a dependency is holding. */
export async function blockedItems(projectPath: string): Promise<BoardResult<BoardItemView[]>> {
  return laneOf("blocked_items", projectPath, "blocked");
}

/**
 * How many comments one read hands back before it starts reporting a remainder.
 *
 * A tool result is never evicted from an agent's context, so an unbounded read costs for the whole
 * session — the argument beadsCommands.ts's header makes about `bd list`, applied to a thread. It
 * bites here specifically: the threads worth reading are the ones on long-lived epics, and this
 * repo's carry hundreds of lines of founder prose each. So the read is bounded and SAYS SO, rather
 * than truncating silently.
 */
export const COMMENT_PAGE_LIMIT = 50;

/** One comment as the concierge sees it — bd's row, unchanged. Re-exported so a caller reading this
 *  domain's result type doesn't have to reach past it into `beadsCommands`. */
export type BoardCommentView = BeadComment;

export interface BoardCommentThread {
  id: string;
  /** Oldest-first, as bd stores them — the order the thinking actually accumulated in. */
  comments: BoardCommentView[];
  /** How many EARLIER comments were left out. `0` when the whole thread is here. */
  omitted: number;
  /** The thread's true length, so a caller can tell a bounded page from a complete one without
   *  arithmetic. */
  total: number;
}

/**
 * The bead's comment thread — the READ half of the append-only rule.
 *
 * A WRITE NOBODY CAN READ IS HALF A FEATURE, which is why this exists alongside `comment_item`
 * rather than after it: an agent that can append but not re-read has to trust that its predecessors
 * wrote nothing relevant, and the accumulated thinking a comment thread exists to preserve is
 * exactly what it cannot see.
 *
 * WHICH END GETS CUT, and why it is the OLD one. `beadsDetail` returns the thread oldest-first, and
 * a bounded page has to drop something. It drops from the FRONT: the most recent comments are the
 * ones carrying the current decision (this bead's own thread is the example — the founder's ruling
 * is the newest entry), while the oldest is usually the filing note the body already says. Order
 * WITHIN the page is left oldest-first regardless, because a thread read backwards reads as a
 * different argument.
 *
 * `getItem` is deliberately NOT changed to carry comments. It is the board's "what is this epic
 * made of" call and is issued for every card the concierge looks at; folding a thread into it would
 * put hundreds of lines of prose into a context that asked for a title and a status. The count is
 * already on every bead (`commentCount`), so "is there a thread here?" stays a free question and
 * this call is what answers "what does it say?".
 */
export async function listComments(
  projectPath: string,
  id: string,
): Promise<BoardResult<BoardCommentThread>> {
  return attempt("list_comments", async () => {
    const detail = await beadsDetail(projectPath, id);
    const all = detail.comments ?? [];
    const comments = all.slice(Math.max(0, all.length - COMMENT_PAGE_LIMIT));
    return { id, comments, omitted: all.length - comments.length, total: all.length };
  });
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/**
 * What the caller answered about epics, exactly as it arrived. Both fields are `string | undefined`
 * rather than required strings because the WHOLE POINT is that a missing answer is a REFUSAL THIS
 * DOMAIN PRODUCES — see {@link createItem}.
 */
export interface EpicDecisionArgs {
  /** `<existing-epic-id>` | `new:<title>` | `none`. */
  decision?: string;
  /** One line saying WHY. Recorded as a comment on the bead that gets created. */
  reason?: string;
}

/** What `create_item` returns. The epic fields are part of the RESULT, not just of the call, so the
 *  concierge can say what it actually did rather than what it asked for. */
export interface CreatedItemView {
  id: string;
  /** The epic this bead was filed under, read back off the created row. `null` for `none`. */
  parent: string | null;
  epicDecision: EpicDecision["kind"];
  /** True when this create minted the epic named in `parent`. */
  epicCreated: boolean;
  /** Whether the decision's reason actually landed on the bead as a comment. Reported rather than
   *  thrown: the bead exists either way, and a caller told "filed" while the record was lost would
   *  never know to re-add it. The ask classification rides the SAME comment, so this covers both. */
  reasonRecorded: boolean;
  /** What the CLASSIFY STEP called this ask, and which rule said so. Returned as well as recorded
   *  so the concierge can CITE the rule in the same breath it reports the filing — a rule it can
   *  read back is a rule it can be argued with. */
  askVerdict: AskClassification["verdict"];
  askRuleId: string;
}

/** How the refusals below open, so the three of them cannot drift into three explanations of one
 *  rule. */
const EPIC_GATE_PREAMBLE =
  "Every task needs an explicit epic decision before it can be filed — pass `epicDecision` as " +
  `${EPIC_DECISION_SYNTAX}, plus a one-line \`epicReason\`. ` +
  "`none` is a perfectly good answer and nothing is wrong with it; the reason is recorded on the " +
  "bead so the choice is a decision rather than a default.";

/** Best-effort candidate epics for a refusal. NEVER throws: this runs on a path that is already
 *  refusing, and a store read that failed must degrade to "no suggestions" rather than replace the
 *  refusal the caller needs to see with a different error. */
async function candidatesFor(
  projectPath: string,
  title: string,
  body: string,
): Promise<EpicCandidate[]> {
  try {
    return candidateEpics(await listBeads(projectPath), { title, body });
  } catch {
    return [];
  }
}

function refuseEpicGate(reason: string, message: string, candidates: readonly EpicCandidate[]) {
  const listed = describeCandidates(candidates);
  return refuse(
    "create_item",
    reason,
    listed
      ? `${message}\n\nExisting epics that look related to this item:\n${listed}`
      : `${message} I could not find an existing epic that looks related, so \`new:<title>\` or ` +
        "`none` are the live options.",
  );
}

/**
 * File a work item — BEHIND THE EPIC GATE (bead `sparkle-xelans.3`).
 *
 * ══ WHY THIS FUNCTION REFUSES ═════════════════════════════════════════════════════════════════
 * The founder asked the concierge to use epics better; it agreed and did not. His ruling was that
 * the fix is an ENFORCEMENT MECHANISM, not a promise: "a prompt instruction can be ignored, a
 * required argument cannot". So `epic.decision` is required HERE, in the domain, and not merely in
 * the registry's zod schema — a zod `Required` error is minted by dispatch's preflight and CANNOT
 * carry the candidate epics, and a refusal that only says "required" is exactly the refusal that
 * teaches nothing. The registry therefore parses the two fields leniently and lets this refuse.
 *
 * The gate is adversarial in ONE direction only. `none` is first-class and unshamed — not every
 * bead needs an epic — and it is the RECORDED REASON that makes the answer a decision. That comment
 * is why `reason` is required for `none` too.
 *
 * ══ WHY `beadsCreate` AND NOT `createBead` ════════════════════════════════════════════════════
 * `services/beads.createBead` has no `parent` argument, so it cannot express two of the three
 * answers. `beadsCreate` can, and it is the same seam `plans.createPlan` already chose for the same
 * reason: it PROBES the store for the row before reporting anything, so the `parent` this returns
 * is read off the created bead rather than echoed back from the request.
 *
 * `priority` is bd's 0-4 (0 = highest) and stays OPTIONAL — omitting it leaves bd's default.
 * `number | null | undefined` is preserved from the previous signature; it crosses to bd as a
 * string because that is what `NewBead` takes.
 */
export async function createItem(
  projectPath: string,
  title: string,
  body: string,
  priority: number | null | undefined,
  epic: EpicDecisionArgs,
): Promise<BoardResult<CreatedItemView>> {
  const decision = parseEpicDecision(epic.decision);
  if (!decision) {
    const given = (epic.decision ?? "").trim();
    return refuseEpicGate(
      "epic-decision-required",
      given
        ? `I can't read "${given}" as an epic decision. ${EPIC_GATE_PREAMBLE}`
        : EPIC_GATE_PREAMBLE,
      await candidatesFor(projectPath, title, body),
    );
  }

  const reason = (epic.reason ?? "").trim();
  if (!reason) {
    return refuse(
      "create_item",
      "epic-reason-required",
      "`epicDecision` is set but `epicReason` is empty, so nothing would be recorded about why — " +
        "and the recorded reason is the whole point of asking. Say in one line why this item " +
        (decision.kind === "none"
          ? "does not belong under an epic."
          : "belongs under that epic."),
    );
  }

  // ONE store read answers BOTH questions a named epic raises — does it exist, and is it an epic —
  // because they are the same list, and a second `bd list` on the create path is seconds. Read only
  // on this branch: `none` and `new:` name nothing to look up, and must not pay for a list.
  if (decision.kind === "existing") {
    const read = await attempt("create_item", () => listBeads(projectPath));
    if (!read.ok) return read;
    const store = read.data;
    const target = store.find((b) => b.id === decision.epicId);
    if (!target) {
      return refuseEpicGate(
        "unknown-epic",
        `There is no bead called \`${decision.epicId}\` in this project, so I can't file under it.`,
        candidateEpics(store, { title, body }),
      );
    }
    if (!isEpic(store, target)) {
      return refuseEpicGate(
        "not-an-epic",
        `\`${decision.epicId}\` ("${target.title}") isn't an epic — it has no children and isn't ` +
          "typed `epic`, so parenting a task under it would invent a hierarchy nobody declared. " +
          "Pick a real epic, or `new:<title>` to open one.",
        candidateEpics(store, { title, body }),
      );
    }
  }

  // `new:` mints the epic FIRST and separately: an epic that exists with no child is a plan nobody
  // has broken down yet (a normal state `isEpic` deliberately admits), whereas a task parented to an
  // id that was never created is a broken edge. Failing between the two is therefore recoverable.
  let epicId: string | null = null;
  let epicCreated = false;
  if (decision.kind === "existing") epicId = decision.epicId;
  if (decision.kind === "new") {
    const madeEpic = await attempt("create_item", () =>
      beadsCreate(projectPath, {
        title: decision.title,
        description: `Opened while filing "${title}". ${reason}`,
        issueType: "epic",
      }),
    );
    if (!madeEpic.ok) return madeEpic;
    if (!madeEpic.data?.id) {
      return refuse(
        "create_item",
        "create-failed",
        "`bd create` ran for the new epic but didn't return an issue id, so I stopped before " +
          "filing a task under an epic I can't name.",
      );
    }
    epicId = madeEpic.data.id;
    epicCreated = true;
  }

  // THE CLASSIFY STEP. Pure and free — derived from the `title` and `body` already in hand, so it
  // runs on EVERY create and there is no argument a hurried turn can leave off.
  const classification = classifyAsk({ title, body });

  const created = await attempt("create_item", () =>
    beadsCreate(projectPath, {
      title,
      description: body,
      // `!= null`, not truthiness: priority 0 is bd's HIGHEST and is the one value a truthiness
      // test silently drops.
      priority: priority != null ? String(priority) : undefined,
      parent: epicId ?? undefined,
    }),
  );
  if (!created.ok) return created;
  if (!created.data?.id) {
    return refuse(
      "create_item",
      "create-failed",
      "`bd create` ran but didn't return an issue id, so I can't confirm the item was filed.",
    );
  }

  // THE DURABLE HALF. Attempted after the bead exists and never allowed to undo it — a failed
  // comment is reported through `reasonRecorded`, not raised as a create failure, because a caller
  // that retried on it would file the item twice.
  //
  // ONE COMMENT CARRIES BOTH RECORDS, and that is deliberate. A second `bd comment` is a second
  // store write on a path with a human waiting for a bead to appear, and the two lines are read
  // together anyway — each keeps its own marker (`EPIC DECISION`, `ASK CLASSIFICATION`), so one
  // grep still finds either.
  let reasonRecorded = true;
  try {
    await beadsComment(
      projectPath,
      created.data.id,
      `${formatEpicDecisionComment({ decision, epicId, epicCreated, reason })}\n\n` +
        formatAskClassificationComment(classification),
    );
  } catch {
    reasonRecorded = false;
  }

  return ok("create_item", {
    id: created.data.id,
    parent: created.data.parent ?? null,
    epicDecision: decision.kind,
    epicCreated,
    reasonRecorded,
    askVerdict: classification.verdict,
    askRuleId: classification.ruleId,
  });
}

/** What `update_item` may change. Every field is optional; at least one must be present, which the
 *  registry's schema enforces so an empty update is a `bad-args` error rather than a silent no-op. */
export interface UpdateItemInput {
  status?: "in_progress" | "closed";
  addLabels?: readonly string[];
  removeLabels?: readonly string[];
  /** bd's 0-4, 0 = highest. Until this existed `update_item` could change status and labels only,
   *  so a priority set wrongly at filing time could never be corrected from here. */
  priority?: number | null;
}

/**
 * Apply an update. Each change is a separate `bd` call, and they are attempted INDEPENDENTLY
 * (`allSettled`) for the same reason `markBeadDelivered` does: a label that fails must not prevent
 * the status change that was also asked for. If any part failed, the whole op refuses and names
 * what broke — the caller retries, and every underlying write is idempotent.
 */
export async function updateItem(
  projectPath: string,
  id: string,
  input: UpdateItemInput,
): Promise<BoardResult<{ id: string; applied: string[] }>> {
  const applied: string[] = [];
  const work: Promise<unknown>[] = [];

  if (input.status === "in_progress") {
    work.push(claimBead(projectPath, id));
    applied.push("status=in_progress");
  } else if (input.status === "closed") {
    work.push(closeBead(projectPath, id));
    applied.push("status=closed");
  }
  for (const label of input.addLabels ?? []) {
    work.push(labelBead(projectPath, "add", id, label));
    applied.push(`+${label}`);
  }
  for (const label of input.removeLabels ?? []) {
    work.push(labelBead(projectPath, "remove", id, label));
    applied.push(`-${label}`);
  }
  // `!= null` deliberately, not a truthiness test: priority 0 is bd's HIGHEST and would be dropped
  // by `if (input.priority)`, which is the one value a triage pass most wants to write.
  if (input.priority != null) {
    work.push(setBeadPriority(projectPath, id, input.priority));
    applied.push(`priority=${input.priority}`);
  }

  const results = await Promise.allSettled(work);
  const failed = results.find((r) => r.status === "rejected");
  if (failed && failed.status === "rejected") {
    if (isBeadsUnavailable(failed.reason)) {
      return refuse(
        "update_item",
        "beads-unavailable",
        "This project doesn't have a beads database (or `bd` isn't installed).",
      );
    }
    return refuse(
      "update_item",
      "beads-failed",
      failed.reason instanceof Error ? failed.reason.message : String(failed.reason),
    );
  }
  return ok("update_item", { id, applied });
}

/**
 * Append a comment to a bead — THE op for adding anything to an item that already exists.
 *
 * ══ WHY THIS IS AN OP AND NOT A SHELL COMMAND (bead `sparkle-ddhk5x`) ═══════════════════════════
 *
 * A bead's BODY is what the founder wrote when he asked for the thing, and it is immutable by
 * design: `update_item` moves status, priority and labels and touches no prose. That is the right
 * model — one shared Dolt store, 50+ agents writing at once, and a mutable body is last-write-wins,
 * so one agent's edit silently destroys another's. Append-only comments let both survive, in order,
 * with attribution.
 *
 * The design was never the problem. DISCOVERABILITY was. This domain shipped with no comment op at
 * all, so the only way to add to a bead was to shell out to `bd comment` — and the concierge, told
 * only that `body` was an unrecognised argument, concluded that a bead simply could not be added to
 * and stored a founder-level design decision in its own private memory instead. The founder had to
 * correct it. A capability reachable only by dropping to the CLI is one most agents never find.
 *
 * So the fix is two-sided and this is one side: the op exists here, and `registry.ts`'s bad-args
 * refusal for a prose field NAMES it (see `appendOnlyBodyHint`). Neither half is sufficient — the
 * op nobody knows about is unused, and the refusal pointing at a shell command is a worse answer
 * than pointing at a tool.
 *
 * NO IDEMPOTENCY KEY, deliberately unfixed here. `bd` gives an append no dedupe handle, so a retry
 * after a lost ack writes a SECOND copy — the same shape as `create_item`, not the claim/close/label
 * shape of `update_item`. That is a TRANSPORT concern and it is answered where the transport is
 * (mcp-control's `DUPLICATES_ON_RETRY_OPS`), not by inventing a key this store cannot enforce.
 */
export async function commentItem(
  projectPath: string,
  id: string,
  text: string,
): Promise<BoardResult<{ id: string; chars: number }>> {
  const done = await attempt("comment_item", () => beadsComment(projectPath, id, text));
  if (!done.ok) return done;
  // `chars`, not the text back. The caller already has what it sent; echoing it doubles the cost of
  // the call in a context window for no information. The count is the ack.
  return ok("comment_item", { id, chars: text.length });
}

/** Permanent. Classified `irreversible` above, so the policy layer defaults it to `ask`. */
export async function deleteItem(
  projectPath: string,
  id: string,
): Promise<BoardResult<{ id: string }>> {
  const done = await attempt("delete_item", () => deleteBead(projectPath, id));
  if (!done.ok) return done;
  return ok("delete_item", { id });
}
