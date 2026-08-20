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
  createBead,
  claimBead,
  closeBead,
  labelBead,
  setBeadPriority,
  deleteBead,
  bucketBeads,
  columnFor,
  childrenOf,
  isBeadsUnavailable,
  type Bead,
} from "../beads";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

export const BOARD_OPS = [
  "list_items",
  "get_item",
  "get_board",
  "ready_items",
  "blocked_items",
  "create_item",
  "update_item",
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
  create_item: "routine",
  update_item: "routine",
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
    if (isBeadsUnavailable(e)) {
      return refuse(
        op,
        "beads-unavailable",
        "This project doesn't have a beads database (or `bd` isn't installed), so it has no work " +
          "graph for me to read. Run `bd init` in the project to start one.",
      );
    }
    return refuse(op, "beads-failed", e instanceof Error ? e.message : String(e));
  }
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

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/**
 * File a work item.
 *
 * `priority` is bd's 0-4 (0 = highest) and is OPTIONAL — omitting it leaves bd's default, which is
 * what every existing caller gets. It is here because filing was the one place priority could not
 * be expressed at all, so nothing that decides how urgent a finding is had anywhere to write it.
 *
 * `number | null | undefined` for the reason `services/beads.ts::createBead` documents: the value
 * crosses into a Rust `Option<i64>`, and that shape travels as an explicit `null`.
 */
export async function createItem(
  projectPath: string,
  title: string,
  body: string,
  priority?: number | null,
): Promise<BoardResult<{ id: string }>> {
  const created = await attempt("create_item", () =>
    createBead(projectPath, title, body, undefined, priority),
  );
  if (!created.ok) return created;
  if (!created.data) {
    return refuse(
      "create_item",
      "create-failed",
      "`bd create` ran but didn't return an issue id, so I can't confirm the item was filed.",
    );
  }
  return ok("create_item", { id: created.data });
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

/** Permanent. Classified `irreversible` above, so the policy layer defaults it to `ask`. */
export async function deleteItem(
  projectPath: string,
  id: string,
): Promise<BoardResult<{ id: string }>> {
  const done = await attempt("delete_item", () => deleteBead(projectPath, id));
  if (!done.ok) return done;
  return ok("delete_item", { id });
}
