// The REVIEW domain — the concierge's access to roborev's findings (concierge PRD section H).
//
// WHAT WAS MISSING. `services/roborev.ts` is install-and-hooks only: it can turn the daemon on, wire
// a repo's git hooks, and probe whether `claude` authenticates. It cannot read one finding. So the
// concierge could tell a human that code review was enabled and nothing whatsoever about what it had
// found — while AGENTS.md is explicit that undrained findings on a spun-down worker's branch become
// backlog nobody reads (316 of them across 172 branches, on 31 branches already merged into main).
// The findings existed; there was no way to ask about them.
//
// THREE OPS, IN THE ORDER A HUMAN ACTUALLY ASKS:
//
//   list_findings — what is open on this branch. Nearly always the whole answer.
//   get_finding   — one review's full text, when the summary is not enough to act on.
//   close_finding — resolve one, WITH a rationale. The only write in the domain.
//
// SCOPED TO A BRANCH BY DEFAULT, NEVER MACHINE-WIDE. roborev's store spans every repo on the
// machine, and "you have 316 open findings" is a true sentence a human can do nothing with. The
// question worth answering is "what is open on the branch in front of me", so `list_findings`
// defaults to the CURRENT branch of the named (or selected) project, and widening it takes an
// explicit `branch`. The branch that was read is returned with the rows, because an empty answer
// carries nothing to infer it from and "no open findings" means nothing without saying on what.
//
// CLOSING IS COMMENT-THEN-CLOSE, AND THE RATIONALE IS NOT OPTIONAL. roborev's own contract (and
// AGENTS.md's: "close any Low you still see with a stated rationale") is `roborev comment <id> -m
// "<why>"` and then `roborev close <id>`. A closed finding with no comment reads exactly like one
// somebody dismissed without reading it, which is strictly worse than leaving it open — the open
// one at least still asks its question. The ordering is enforced in Rust (review_cmd.rs): if the
// comment fails, the close does not run.
//
// WHY `close_finding` IS `ask` AND NOT `routine`. It is the one op here that destroys reviewer
// signal. It is genuinely recoverable (`roborev close --reopen` puts it back), so it is NOT
// classified `irreversible` — that would overstate the damage. It is `disruptive`: it retires, on
// the human's behalf, a gate that would otherwise have blocked a push, and the fix that finding
// asked for may then never happen. `disruptive` is the arm of the shared risk vocabulary that
// derives `ask` without claiming the act cannot be undone.
//
// ROBOREV IS OPTIONAL, AND SO IS ITS DAEMON. A machine with no roborev, a daemon that is stopped,
// and a repo roborev has never reviewed are three DIFFERENT supported states, none of them a bug —
// and the last one is the trap. `roborev list` on an untracked repo returns an empty array, which
// is indistinguishable from "registered, nothing open" unless someone asks. Reporting the first as
// the second tells a human their code is clear when nothing has ever looked at it. Each state gets
// its own refusal code below, the same way board.ts reports `beads-unavailable`.
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

export const REVIEW_OPS = ["list_findings", "get_finding", "close_finding"] as const;

export type ReviewOp = (typeof REVIEW_OPS)[number];

export type ReviewRisk = "read-only" | "routine" | "disruptive" | "irreversible";

/**
 * EXHAUSTIVE by construction — a `Record<ReviewOp, …>`, so an op added to `REVIEW_OPS` without a
 * classification fails `tsc` rather than defaulting to something permissive.
 *
 * The two reads are `read-only`: each is one `roborev` query that writes nothing. `close_finding` is
 * `disruptive` — see the header for why that word and not `irreversible`. The policy layer derives
 * its default decision from this map, so the classification is load-bearing rather than commentary:
 * `disruptive` derives to `ask`, which is the behaviour this op needs.
 */
export const REVIEW_RISK: Record<ReviewOp, ReviewRisk> = {
  list_findings: "read-only",
  get_finding: "read-only",
  close_finding: "disruptive",
};

// ---------------------------------------------------------------------------------------------
// Results — the lifecycle/board/diff convention
// ---------------------------------------------------------------------------------------------

export interface ReviewOk<T> {
  ok: true;
  op: ReviewOp;
  risk: ReviewRisk;
  data: T;
}

export interface ReviewRefusal {
  ok: false;
  op: ReviewOp;
  risk: ReviewRisk;
  reason: string;
  message: string;
}

export type ReviewResult<T> = ReviewOk<T> | ReviewRefusal;

function ok<T>(op: ReviewOp, data: T): ReviewOk<T> {
  return { ok: true, op, risk: REVIEW_RISK[op], data };
}

function refuse(op: ReviewOp, reason: string, message: string): ReviewRefusal {
  return { ok: false, op, risk: REVIEW_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// The refusal vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * This domain's machine-readable refusal codes.
 *
 * Every one of the first four is a SUPPORTED STATE rather than a failure, and they are separate
 * codes because the remedies are different and a caller must be able to branch on which: install
 * roborev / start the daemon / review this repo for the first time / name a branch. Collapsing them
 * into one "roborev unavailable" would leave the concierge unable to say which of four things is
 * wrong, and `roborev-unregistered` in particular is the one that must never be reported as an
 * empty list.
 */
export const REVIEW_REFUSALS = {
  /** The `roborev` binary isn't installed. Sparkle runs fine without it. */
  missing: "roborev-missing",
  /** Installed, but the local daemon isn't running — every read fails until it is started. */
  daemonDown: "roborev-daemon-down",
  /** The daemon is up and has never tracked this repo. NOT the same as "nothing open". */
  unregistered: "roborev-unregistered",
  /** No current branch to scope to (detached HEAD), and the caller named none. */
  detachedHead: "roborev-detached-head",
  /** roborev wedged and was killed at the timeout. */
  timeout: "roborev-timeout",
  /** The arguments could not be used (a job id that is not one, an unusable branch). */
  badArgs: "roborev-bad-args",
  /** roborev ran and failed for a reason this build does not recognise. The honest bucket. */
  failed: "roborev-failed",
  /** roborev answered, but not with JSON this build can read. */
  unreadable: "roborev-unreadable",
} as const;

/** Every tag the Rust side may prefix an error with, mapped to the sentence the concierge says.
 *
 *  The Rust commands report failure as `"<tag>: <detail>"` — the same convention worktree.rs's diff
 *  commands use for `missing-head:` / `missing-base:`. Classifying on that PREFIX rather than
 *  regexing roborev's English is what keeps a reworded CLI message from silently reclassifying a
 *  stopped daemon as an unknown failure. */
const REMEDY: Record<string, string> = {
  [REVIEW_REFUSALS.missing]:
    "roborev isn't installed on this machine, so there are no code-review findings to read. " +
    "It's optional — Sparkle works without it. Turn it on in Settings to install it.",
  [REVIEW_REFUSALS.daemonDown]:
    "roborev is installed but its daemon isn't running, so I can't reach any findings. This is " +
    "NOT the same as there being none — I genuinely can't see. Restart it through launchd so it " +
    "comes up with the right PATH: `launchctl kickstart -k gui/$(id -u)/co.plow.roborev-daemon`. " +
    "Do NOT run `roborev daemon start` — it's broken on this machine (it needs setsid) and each " +
    "failed attempt leaves an orphan daemon on a bare PATH that answers healthy while it can reach " +
    "no review agent, so review goes dark silently.",
  [REVIEW_REFUSALS.unregistered]:
    "roborev has never reviewed anything in this project, so it has no findings to show. An empty " +
    "answer here would mean \"nothing has looked\", not \"nothing was found\" — `roborev init` in " +
    "the project starts it reviewing.",
  [REVIEW_REFUSALS.detachedHead]:
    "This project's checkout has no current branch (detached HEAD), so I don't know whose findings " +
    "to read. Name a `branch` explicitly.",
  [REVIEW_REFUSALS.timeout]:
    "roborev didn't answer in time. Its review database can be slow to open cold — worth another " +
    "try, and worth checking the daemon if it keeps happening.",
};

/** The tags this domain owns, as a set — so a tagged error keeps its OWN code rather than being
 *  flattened into `roborev-failed`. Derived from REVIEW_REFUSALS rather than restated, so a code
 *  added there is recognised here without a second list to keep in step. */
const KNOWN_TAGS = new Set<string>(Object.values(REVIEW_REFUSALS));

/**
 * Split a Rust (or parser) error into its tag and a sentence to say.
 *
 * A recognised tag is FORWARDED as the code — that is the whole point of the vocabulary, and a
 * caller that could branch on `roborev-daemon-down` must not receive `roborev-failed` instead. Tags
 * with a standing remedy get that sentence; the rest keep their own detail, which came from
 * somewhere that knew more about the failure than a generic sentence here would.
 *
 * An UNTAGGED message is `roborev-failed` with its text intact. That bucket is allowed to be
 * uninformative — pretending to recognise something is how a caller ends up confidently telling a
 * human the wrong remedy.
 */
function classify(op: ReviewOp, e: unknown): ReviewRefusal {
  const raw = e instanceof Error ? e.message : String(e);
  const colon = raw.indexOf(":");
  const tag = colon > 0 ? raw.slice(0, colon) : raw.trim();
  const detail = colon > 0 ? raw.slice(colon + 1).trim() : "";
  if (KNOWN_TAGS.has(tag)) {
    // `||` and not `??`: `detail` is a string that is EMPTY when the tag carried no colon, and an
    // empty message is the one thing a refusal may not have.
    return refuse(op, tag, REMEDY[tag] || detail || raw);
  }
  return refuse(op, REVIEW_REFUSALS.failed, detail || raw);
}

async function attempt<T>(op: ReviewOp, run: () => Promise<T>): Promise<ReviewResult<T>> {
  try {
    return ok(op, await run());
  } catch (e) {
    return classify(op, e);
  }
}

// ---------------------------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------------------------

/**
 * One open review, normalized out of roborev's JSON.
 *
 * THIS SHAPE IS A CONTEXT BUDGET, NOT JUST A TYPE. A live `roborev list --json` row averages ~34 KB
 * and peaks at ~137 KB, because every row carries the FULL review `prompt` — which embeds the
 * previous reviews and the diff. At the default page size that is most of a megabyte of stdout for
 * an answer whose useful part is a few hundred bytes. A tool result is never evicted from an LLM's
 * context, so handing that through once would be paid for the entire session. The bulky fields
 * (`prompt`, `diff_content`, `patch`, `token_usage`, `command_line`, `worktree_path`) are dropped
 * here and never reach the caller; the raw string lives in JS memory for a few ms instead. That is
 * the same trade `beads_cmd.rs` documents for `bd`, and it is asserted in the tests.
 *
 * NO PER-ROW `branch`. roborev leaves the column empty on every row observed live (it is
 * `omitempty` and nullable), and an always-blank field invites the caller to report "branch:
 * (blank)". The branch is on {@link FindingList} instead, where it is resolved rather than guessed —
 * and every row IS on that branch by construction, since the query filters on it.
 */
export interface Finding {
  /** roborev's job id — the handle `get_finding` and `close_finding` take. Always a string, even
   *  though roborev emits it as a number: it is an identifier, not a quantity, and a caller that
   *  does arithmetic on it has already made a mistake. */
  id: string;
  /** The commit the review was of — a sha, or roborev's own ref for an uncommitted review. */
  ref: string;
  /** The reviewed commit's subject line. The one field that lets a human recognise WHICH commit is
   *  being talked about; a bare sha does not. */
  commitSubject: string;
  /** queued | running | done | failed | … — roborev's own vocabulary, passed through. */
  status: string;
  /** `PASS` | `FAIL`, or null when the review has no verdict yet. See {@link normalizeVerdict} —
   *  roborev's own wire values are the single letters `P` and `F`, which are expanded here. */
  verdict: string | null;
  /** Which agent produced the review (claude-code, codex, …). Empty when roborev didn't say. */
  agent: string;
  /** When it was enqueued, as roborev printed it (ISO-8601 on the live wire). Not parsed into a
   *  Date — the caller formats, and a pre-parsed value would bake in a timezone guess. */
  enqueuedAt: string;
}

/** What `list_findings` returns. The BRANCH is part of the answer, not context — see the header. */
export interface FindingList {
  branch: string;
  findings: Finding[];
  /** True when the row cap bit. There is no exact total available (roborev's own `--limit`
   *  truncates server-side without reporting a count), so this says "there may be more" and
   *  deliberately does not claim a number it cannot know. */
  capped: boolean;
}

/** The Rust `RoborevListOut`. */
interface RoborevListOut {
  branch: string;
  /** The row cap Rust ACTUALLY applied, after its own clamp — not the one the caller asked for. */
  limit: number;
  json: string;
}

// ---------------------------------------------------------------------------------------------
// Normalizing roborev's JSON
// ---------------------------------------------------------------------------------------------

// DEFENSIVE ON PURPOSE, the same way services/beads.ts is with `bd`. roborev is a separately
// versioned binary we do not ship in lockstep, its JSON is a Go struct marshalled with `omitempty`
// (so absent keys are NORMAL, not corruption), and its column names have both snake_case and
// camelCase spellings in circulation. Reading from an index signature and taking whichever key is
// present costs a few lines and survives a version bump; a typed cast would compile and then
// produce `undefined` fields at runtime with nothing to say about it.

type RawFinding = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  // roborev emits ids as JSON numbers. Accepting that here is what keeps `id` a string end to end
  // rather than making every caller handle both.
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function pick(raw: RawFinding, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = asString(raw[key]);
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/**
 * roborev's verdict, which arrives in two shapes and one surprising encoding.
 *
 * ON THE LIVE WIRE IT IS A SINGLE LETTER — `"P"` or `"F"`, not `"PASS"`/`"FAIL"` (confirmed against
 * roborev v0.53.1: 12 sampled rows were 9×`P`, 3×`F`). Passing that through unexpanded would hand
 * the concierge a bare `"P"` to interpret, and "P" is equally readable as "pending". They are
 * expanded here, once, rather than left for every caller to decode — AGENTS.md's own shorthand for
 * a failing review is "verdict=F", so the letters are the real contract, not a guess.
 *
 * Older rows may instead carry `verdict_bool`. A review with NEITHER has not been judged yet, and
 * that is reported as `null` rather than defaulted — "no verdict" and "passed" are opposite facts,
 * and a false pass is the one that gets a real finding ignored.
 *
 * Anything unrecognised is passed through uppercased rather than forced into PASS/FAIL: a verdict
 * letter this build has not seen is better reported verbatim than mapped to a guess.
 */
function normalizeVerdict(raw: RawFinding): string | null {
  const text = pick(raw, "verdict")?.toUpperCase();
  if (text) {
    if (text === "P" || text === "PASS") return "PASS";
    if (text === "F" || text === "FAIL") return "FAIL";
    return text;
  }
  const flag = raw.verdict_bool ?? raw.verdictBool;
  if (typeof flag === "boolean") return flag ? "PASS" : "FAIL";
  return null;
}

/** Keep ONLY the fields below. Everything else roborev sends — notably the multi-KB `prompt` — is
 *  dropped here and never reaches the caller. See {@link Finding} for why that is the point. */
function normalizeFinding(raw: RawFinding): Finding {
  return {
    id: pick(raw, "id", "job_id", "jobId") ?? "",
    ref: pick(raw, "git_ref", "gitRef", "sha", "commit") ?? "",
    commitSubject: pick(raw, "commit_subject", "commitSubject", "subject") ?? "",
    status: pick(raw, "status", "state") ?? "",
    verdict: normalizeVerdict(raw),
    agent: pick(raw, "agent") ?? "",
    enqueuedAt: pick(raw, "enqueued_at", "enqueuedAt", "created_at", "createdAt") ?? "",
  };
}

/**
 * Parse `roborev list --json`'s stdout into rows.
 *
 * Tolerates the three shapes the CLI has been observed to produce — a bare array, `{ jobs: [...] }`,
 * and an empty body for "nothing matched" — and throws a TAGGED error for anything else, so an
 * unreadable answer lands on `roborev-unreadable` rather than on a silent empty list. That
 * distinction is the same one the whole module turns on: a list nobody could read must never be
 * reported as a list with nothing in it.
 *
 * Exported for tests: it is the one piece of real logic here, and it is worth asserting against the
 * shapes a version bump can produce without standing up a daemon.
 */
export function parseFindings(json: string): Finding[] {
  const body = json.trim();
  if (!body) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `${REVIEW_REFUSALS.unreadable}: roborev answered with something that isn't JSON: ${body.slice(0, 200)}`,
    );
  }
  if (parsed === null || parsed === undefined) return [];
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { jobs?: unknown }).jobs)
      ? ((parsed as { jobs: unknown[] }).jobs)
      : null;
  if (!rows) {
    throw new Error(
      `${REVIEW_REFUSALS.unreadable}: expected a list of reviews from roborev, got: ${body.slice(0, 200)}`,
    );
  }
  return rows.map((row) => normalizeFinding((row ?? {}) as RawFinding));
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/**
 * Open findings for one branch of one repo.
 *
 * `branch` is optional and defaults to the repo's CURRENT branch (resolved in Rust, so this is the
 * branch the checkout is really on rather than one inferred from an agent id that may be stale).
 * The branch that was read comes back in the result — see FindingList.
 */
export async function listFindings(
  repoPath: string,
  options: { branch?: string; limit?: number } = {},
): Promise<ReviewResult<FindingList>> {
  return attempt("list_findings", async () => {
    const out = await invoke<RoborevListOut>("roborev_list_findings", {
      repo: repoPath,
      branch: options.branch ?? null,
      limit: options.limit ?? null,
    });
    const findings = parseFindings(out.json);
    return {
      branch: out.branch,
      findings,
      // roborev truncates server-side and reports no total, so a FULL PAGE is the only evidence
      // available that there may be more. Compared against the cap Rust actually applied, not the
      // one the caller asked for: a `limit: 5000` is clamped to MAX_LIMIT, and comparing against
      // 5000 would report a truncated page as complete — the silent-truncation failure this exists
      // to prevent. Stated as "may", never as a count we do not have.
      capped: findings.length >= out.limit,
    };
  });
}

/**
 * Pull the review PROSE out of `roborev show --json`.
 *
 * The valuable part of a finding is the sentences the reviewer wrote, and `--json` wraps them in an
 * envelope whose field name has moved between versions (the store column is `output`). Handing the
 * whole envelope to an LLM would make it re-parse JSON to reach the one string it wanted, and pay
 * for the rest of the envelope in context permanently.
 *
 * FALLS BACK TO THE RAW BODY rather than throwing. Unlike the list path, an envelope this build
 * cannot read is not dangerous here: the raw text still CONTAINS the review, so returning it is
 * degraded but honest. Refusing would withhold an answer that is sitting right there.
 *
 * Exported for tests.
 */
export function extractReviewText(raw: string): string {
  const body = raw.trim();
  if (!body.startsWith("{")) return body;
  try {
    const obj = JSON.parse(body) as RawFinding;
    const text = pick(obj, "output", "review", "text", "body", "content");
    return text ?? body;
  } catch {
    return body;
  }
}

/** One finding's full review text — the actual prose the reviewer wrote. */
export async function getFinding(
  repoPath: string,
  id: string,
): Promise<ReviewResult<{ id: string; review: string }>> {
  if (!id?.trim()) {
    return refuse(
      "get_finding",
      REVIEW_REFUSALS.badArgs,
      "Which finding? Call list_findings first and name one of the ids it returns.",
    );
  }
  return attempt("get_finding", async () => ({
    id,
    review: extractReviewText(await invoke<string>("roborev_show_finding", { repo: repoPath, id })),
  }));
}

// ---------------------------------------------------------------------------------------------
// The one write
// ---------------------------------------------------------------------------------------------

/**
 * Close a finding, recording WHY.
 *
 * The rationale is required by this signature and refused when blank BEFORE any call is made — not
 * because a blank string would break roborev, but because it would succeed. A finding closed with
 * no comment is indistinguishable from one dismissed unread, and the whole reason AGENTS.md tells
 * people to close a Low "with a stated rationale" is that the next reader has no other way to tell
 * a finished decision from abandoned backlog.
 *
 * The comment-then-close ORDERING lives in Rust (review_cmd.rs), where a failed comment aborts the
 * close. It is not enforced twice: a second copy here would be the one that drifts.
 */
export async function closeFinding(
  repoPath: string,
  id: string,
  rationale: string,
): Promise<ReviewResult<{ id: string; rationale: string }>> {
  if (!id?.trim()) {
    return refuse(
      "close_finding",
      REVIEW_REFUSALS.badArgs,
      "Which finding? Call list_findings first and name one of the ids it returns.",
    );
  }
  if (!rationale?.trim()) {
    return refuse(
      "close_finding",
      REVIEW_REFUSALS.badArgs,
      "Closing a finding needs a rationale — it is recorded on the review with `roborev comment` " +
        "before the close, so the next reader can tell a finished decision from an unread one.",
    );
  }
  const done = await attempt("close_finding", () =>
    invoke<void>("roborev_close_finding", { repo: repoPath, id, rationale }),
  );
  if (!done.ok) return done;
  return ok("close_finding", { id, rationale: rationale.trim() });
}

// NO DESCRIPTOR ARRAY HERE, DELIBERATELY — the same reasoning diff.ts states. This domain's op list
// and write flags are derived from `REVIEW_OPS` and `REVIEW_RISK`, so a descriptor array would have
// no consumer, and the text a model actually reads before calling is the `sparkle_review`
// description in mcp-control's server.ts. A local copy nobody reads is how the model's instructions
// and the tests that "cover" them drift apart.
