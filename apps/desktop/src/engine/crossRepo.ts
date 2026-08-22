// CROSS-REPO WORK: the agent whose code does not land in the project it is bound to.
//
// WHY THIS EXISTS (bead `sparkle-pgh1ue`). Every landed-work probe in this app resolves against the
// agent's BOUND PROJECT worktree — `agent_workflow_state` takes the project `root`, resolves
// `sparkle/agent-<id>` inside it, and measures ancestry into that repo's default branch. That is
// correct for the overwhelming majority, and structurally blind for the rest: an agent handed a task
// in ANOTHER repository commits nothing to its bound branch, so `ahead_of_base` is 0, no PR is found,
// nothing has landed, and the row files under "Local: Nothing Yet" — forever, however finished the
// work is.
//
// The founder, on agent `Drodio Publishing MCP Images`: *"why the hell is it still in local? Nothing
// yet. Versus being in a merged domain or shipped to production status."* Its work was merged as
// `drodio/drodio-website#253` at `79b157a`, proven by ancestry, while its bound-project branch held
// zero commits BY DESIGN. The bound-project reading was not wrong about the branch; it was answering
// a question nobody asked.
//
// TWO COMPLEMENTARY HALVES, and they are complementary on purpose — neither alone is enough:
//
//   (a) THE STAMP — {@link LandedElsewhere}. The agent RECORDS where its work actually landed
//       (`owner/repo#N`), via the `set_agent_landed` control op. This is a TRUTH SOURCE the probe
//       cannot derive: no amount of looking at the bound repo can reveal a PR in a different one.
//       {@link stageFromLandedStamp} turns it into a real ladder stage, and `deriveLiveStage` PREFERS
//       it over the bound-project reading whenever it is present.
//
//   (b) THE GUARD — {@link detectCrossRepoTarget}. Before any stamp exists (the agent is still
//       working, or predates the op, or never calls it) the assignment text itself is evidence: a
//       task naming a repository other than the bound one means this row's work is NOT measurable
//       from here. Such a row renders "Tracked Elsewhere" — an honest "we cannot see it" — rather
//       than a false "Nothing Yet", which asserts the work does not exist.
//
// The distinction between (a) and (b) is the distinction between KNOWING and NOT KNOWING, and the
// copy must keep them apart. (a) makes a positive claim backed by an id the human can click through
// to. (b) makes no claim about progress at all. Collapsing (b) into an optimistic stage would trade
// one false status for another, which is the failure this whole module exists to end.
//
// Pure — no React, no IPC, no store. Every rule here is unit-tested in `crossRepo.test.ts`.
import type { WorkflowStageId } from "./workflowStage";

// ── (a) The stamp ────────────────────────────────────────────────────────────────────────────────

/** How far the stamped work got IN THE OTHER REPO. Deliberately the same vocabulary as
 *  `WorkflowState.prState` so a reader does not have to learn a second one — plus `shipped`, which a
 *  PR state cannot carry. */
export type LandedElsewhereState = "open" | "merged" | "closed";

/**
 * An agent's own record of where its work landed, in a repository other than the one its project is
 * bound to. Written by the `set_agent_landed` control op; read by `deriveLiveStage`.
 *
 * SELF-REPORTED, AND THE TYPE SAYS SO RATHER THAN PRETENDING OTHERWISE. Nothing here is verified
 * against GitHub — the app has no cheap way to probe an arbitrary foreign repo on the poll path, and
 * a stamp is worth having without one. What makes that acceptable is that every field is a POINTER
 * a human can check in one click (`url`, `repo#prNumber`, `sha`), so a wrong stamp is falsifiable in
 * the same surface it is displayed in. Do NOT widen this into a claim the row cannot substantiate:
 * if you ever add a verification probe, add a field recording that it ran rather than silently
 * upgrading the meaning of these.
 */
export interface LandedElsewhere {
  /** Lowercase `owner/repo`. Normalized by {@link normalizeRepoSlug} — never raw caller input. */
  repo: string;
  /** The pull request number in `repo`, when the landing went through one. */
  prNumber?: number;
  /** A link the human can open — the PR, the commit, the release. */
  url?: string;
  /** The landing commit in `repo`, when known. Free-form (short or full sha). */
  sha?: string;
  /** How far it got. ABSENT IS NOT "merged": an unstated state floors at `pushed` (see
   *  {@link stageFromLandedStamp}) because a stamp naming a remote repo proves the work reached a
   *  remote and nothing more. */
  state?: LandedElsewhereState;
  /** The work is in a published release / deployed. Only meaningful alongside `state: "merged"`. */
  shipped?: boolean;
  /** Epoch ms the stamp was written. Lets a reader tell a fresh stamp from a stale one and gives the
   *  row something to age. */
  stampedAt: number;
  /** Whatever the agent wanted the human to read beside it (one line). */
  note?: string;
}

/**
 * `owner/repo`, lowercased, from any of the shapes an agent plausibly writes — or `null`.
 *
 * Accepted: `owner/repo`, `owner/repo#123`, `https://github.com/owner/repo`, a deep GitHub URL
 * (`…/owner/repo/pull/253`, `…/owner/repo/commit/<sha>`), and `git@github.com:owner/repo.git`.
 *
 * REFUSES rather than guesses. A slug is what decides whether a row is cross-repo at all, so a
 * lenient parse here shows up as a WRONG STATUS on somebody's row — the exact failure this module
 * exists to fix, pointed the other way. Anything that is not unambiguously `owner/repo` is `null`.
 */
export function normalizeRepoSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let s = value.trim();
  if (!s) return null;
  // `git@github.com:owner/repo.git` → `owner/repo.git`
  s = s.replace(/^git@[\w.-]+:/i, "");
  // Any http(s) URL → its path. A non-GitHub host is refused outright: `owner/repo` on some other
  // forge is not a slug this app can resolve, and quietly accepting it invents a repo identity.
  const urlMatch = /^(?:https?:\/\/)?(?:www\.)?([\w.-]+)\/(.+)$/i.exec(s);
  if (urlMatch && /\./.test(urlMatch[1] as string)) {
    if ((urlMatch[1] as string).toLowerCase() !== "github.com") return null;
    s = urlMatch[2] as string;
  }
  // Drop a `#123` suffix, a trailing `.git`, and any query/fragment tail.
  s = s.split(/[?#]/)[0] as string;
  s = s.replace(/\.git$/i, "");
  s = s.replace(/^\/+|\/+$/g, "");
  const parts = s.split("/");
  // A deep GitHub path (`owner/repo/pull/253`) keeps its first two segments; anything else must be
  // exactly two.
  if (parts.length > 2) {
    const third = (parts[2] ?? "").toLowerCase();
    const DEEP = new Set(["pull", "pulls", "commit", "commits", "tree", "blob", "releases", "issues", "compare", "actions"]);
    if (!DEEP.has(third)) return null;
  }
  // TRAILING DOTS ARE SENTENCE PUNCTUATION, NOT PART OF THE NAME. GitHub refuses an owner or repo
  // ending in `.`, so stripping one can never damage a real slug — and without this a URL written at
  // the end of a sentence ("…lands in https://github.com/drodio/drodio-website.") normalizes to a
  // repo that does not exist, which then never equals the bound slug and marks the row cross-repo for
  // the wrong reason. Caught by `the founder's case`, whose task text is a sentence.
  const owner = (parts[0] ?? "").replace(/\.+$/, "");
  const repo = (parts[1] ?? "").replace(/\.+$/, "");
  if (!owner || !repo) return null;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  // `.` and `..` are path segments, not repo names — and `apps/../lib` must never read as a slug.
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** A PR number embedded in `owner/repo#123` or a `…/pull/123` URL, or `undefined`. */
export function prNumberFromReference(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const hash = /#(\d{1,9})\b/.exec(value);
  if (hash) return Number(hash[1]);
  const pull = /\/pulls?\/(\d{1,9})\b/i.exec(value);
  if (pull) return Number(pull[1]);
  return undefined;
}

/** The parse result for a `set_agent_landed` payload: a normalized stamp, or the reason it was
 *  refused (which the op hands straight back to the calling agent so it can correct itself). */
export type LandedStampParse =
  | { ok: true; stamp: LandedElsewhere }
  | { ok: false; error: string };

const LANDED_STATES: ReadonlySet<string> = new Set(["open", "merged", "closed"]);

/**
 * Validate + normalize a `set_agent_landed` payload into a {@link LandedElsewhere}.
 *
 * `now` is injected rather than read from the clock so the stamp's timestamp is testable — the
 * defaulted-seam trap in AGENTS.md: a `Date.now()` read inside here would be covered by nothing,
 * because every test would pass its own.
 */
export function parseLandedStamp(payload: unknown, now: number): LandedStampParse {
  const p = (payload ?? {}) as Record<string, unknown>;
  // `repo` is the required field, but accept the whole reference in it (`owner/repo#253`, a PR URL)
  // — that is what an agent has in hand at the moment it wants to stamp, and demanding it be split
  // into two fields is how a truth source goes unused.
  const rawRepo = typeof p.repo === "string" && p.repo.trim() ? p.repo : p.url;
  const repo = normalizeRepoSlug(rawRepo);
  if (!repo) {
    return {
      ok: false,
      error:
        "repo is required and must be owner/repo (a GitHub URL or owner/repo#123 also works) — " +
        "this is the repository your work actually landed in, not the project you are bound to",
    };
  }
  const stamp: LandedElsewhere = { repo, stampedAt: now };

  const prRaw = p.pr ?? p.prNumber;
  const prNumber =
    typeof prRaw === "number" && Number.isInteger(prRaw) && prRaw > 0
      ? prRaw
      : (prNumberFromReference(rawRepo) ?? prNumberFromReference(p.url));
  if (prNumber !== undefined) stamp.prNumber = prNumber;

  if (typeof p.url === "string" && p.url.trim()) stamp.url = p.url.trim();
  if (typeof p.sha === "string" && p.sha.trim()) stamp.sha = p.sha.trim();
  if (typeof p.note === "string" && p.note.trim()) stamp.note = p.note.trim();

  if (p.state !== undefined && p.state !== null) {
    if (typeof p.state !== "string" || !LANDED_STATES.has(p.state)) {
      return { ok: false, error: `state must be one of open | merged | closed (got ${JSON.stringify(p.state)})` };
    }
    stamp.state = p.state as LandedElsewhereState;
  }
  // `shipped` only means something on top of a merge. Accepting it beside `open` would let a row
  // claim production while its PR is still under review.
  if (p.shipped === true) {
    if (stamp.state !== "merged") {
      return {
        ok: false,
        error: 'shipped: true requires state: "merged" — work cannot be in a release before it is merged',
      };
    }
    stamp.shipped = true;
  }
  return { ok: true, stamp };
}

/**
 * The ladder stage a stamp proves — the (a) half's whole output.
 *
 * THE FLOOR IS `pushed`, NOT `merged`, for a stamp that states no `state`. All a bare
 * `{ repo }` stamp establishes is that this agent's work went to a remote repository; claiming a
 * merge on that would be inventing the very status the founder is complaining about. Callers get to
 * raise it by stating the state, which is what the op's description tells them to do.
 */
export function stageFromLandedStamp(stamp: LandedElsewhere): WorkflowStageId {
  if (stamp.state === "merged") return stamp.shipped ? "shipped" : "merged";
  if (stamp.state === "open") return "pull_request";
  // "closed" and unstated both floor here: a closed PR was still pushed, and so was work that
  // reached a foreign repo at all.
  return "pushed";
}

/** A one-line, human-facing readout of a stamp — `drodio/drodio-website#253 · merged`. Used on the
 *  row so the claim carries the id that substantiates it rather than standing on its own. */
export function landedStampLabel(stamp: LandedElsewhere): string {
  const ref = stamp.prNumber ? `${stamp.repo}#${stamp.prNumber}` : stamp.repo;
  const state = stamp.shipped ? "shipped" : (stamp.state ?? "pushed");
  return `${ref} · ${state}`;
}

// ── (b) The guard ────────────────────────────────────────────────────────────────────────────────

// The shapes a repository reference takes in an assignment, STRONGEST FIRST — and this list is
// deliberately short.
//
// ⚠️ A BARE `owner/repo` IS NOT ON IT, and must never be added. Prose about this codebase is full of
// `apps/desktop`, `src/engine`, `scripts/tests` — every one of which matches `\w+/\w+`. Treating
// those as repositories would mark most of the fleet cross-repo and file working agents under
// "Tracked Elsewhere", which is a WORSE wrong status than the one this fixes: it is wrong about rows
// that were right before. Every pattern below requires an explicit marker (a github.com host, a `#N`
// PR reference, or the literal word "repo"/"repository") that a file path cannot accidentally carry.
const REPO_REFERENCE_PATTERNS: readonly RegExp[] = [
  // https://github.com/owner/repo…  (also matches a bare `github.com/owner/repo`)
  /\bgithub\.com[/:]([\w.-]+\/[\w.-]+(?:\/(?:pull|pulls|commit|commits|tree|blob|releases|issues|compare|actions)\/[\w.-]+)?)/gi,
  // owner/repo#123 — the PR shorthand. The `#N` is the marker; a file path never carries one.
  /\b([\w.-]+\/[\w.-]+#\d{1,9})\b/g,
  // "repo: owner/repo", "repository owner/repo", "in the owner/repo repo"
  /\b(?:repo|repository)\b\s*[:=]?\s*([\w.-]+\/[\w.-]+)\b/gi,
  /\b([\w.-]+\/[\w.-]+)\s+(?:repo|repository)\b/gi,
];

/**
 * Every repository this text unambiguously names, normalized and de-duplicated, in first-seen order.
 * Exported for its own sake because "which repos does this task mention" is a question worth being
 * able to ask and to test directly.
 */
export function repoReferencesIn(text: string | null | undefined): string[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const seen: string[] = [];
  for (const pattern of REPO_REFERENCE_PATTERNS) {
    // A `g` regex carries `lastIndex` across calls; these are module-level constants, so reset it
    // or the second call on the same pattern starts mid-string and silently misses matches.
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const slug = normalizeRepoSlug(m[1]);
      if (slug && !seen.includes(slug)) seen.push(slug);
    }
  }
  return seen;
}

/**
 * THE ASSIGNMENT-TIME GUARD: the first repository this task names that is NOT the bound project's —
 * or `null` for "nothing here says the work goes elsewhere".
 *
 * FAILS CLOSED TO TODAY'S BEHAVIOUR IN BOTH DIRECTIONS, which is the property to preserve:
 *   • `boundSlug` unknown (`null`) ⇒ `null`. We cannot tell same from different without knowing what
 *     "same" is, and guessing would mark ordinary agents cross-repo. An unresolved slug is common —
 *     `conciergeTools/repoSlug` is a cache, and a cold miss reads `null`.
 *   • no unambiguous reference in the text ⇒ `null`. Silence is not evidence.
 * In both cases the row keeps exactly the status it has today. This guard may only ever move a row
 * OFF a false "Nothing Yet"; it must never be able to move a correctly-filed row anywhere.
 */
export function detectCrossRepoTarget(
  text: string | null | undefined,
  boundSlug: string | null | undefined,
): string | null {
  const bound = normalizeRepoSlug(boundSlug);
  if (!bound) return null;
  for (const slug of repoReferencesIn(text)) {
    if (slug !== bound) return slug;
  }
  return null;
}

// ── The two halves, combined ─────────────────────────────────────────────────────────────────────

/** How many repo references an assignment may latch. A cap, because this is PERSISTED per agent and
 *  an assignment naming five repositories tells us nothing a shorter list does not. Four is well
 *  above the real cases (one foreign repo, sometimes named beside the bound one) and bounds the
 *  record. */
export const ASSIGNMENT_REPOS_CAP = 4;

/**
 * THE ASSIGNMENT-TIME LATCH: the repositories an agent's OPENING assignment named, normalized and
 * capped — computed once, when the work is handed over, and persisted on the row.
 *
 * WHY LATCH RATHER THAN RE-DERIVE (roborev 67500, Medium). The obvious implementation reads the
 * agent's CURRENT prompt, and that is wrong in a way that is worse than the bug it fixes: an agent
 * working entirely in the bound repo would flip to "Tracked Elsewhere" the moment any prompt happened
 * to mention another repository ("port the fix from owner/repo#253"), and flip back on the next one.
 * The row's rung would then oscillate with CHAT CONTENT rather than with work state — a status that
 * moves for reasons the work did not.
 *
 * IT DELIBERATELY STORES REFERENCES, NOT A VERDICT. Comparing against the bound repo happens at READ
 * time, in `detectCrossRepoTarget`, for two reasons: the bound slug comes from an async cache that
 * can still be cold at assignment time (latching a verdict then would silently fail closed forever
 * for that agent), and a project whose remote changes should not carry a verdict computed against
 * the old one. Storing evidence and deciding later is the arrangement that survives both.
 */
export function assignmentRepos(text: string | null | undefined): string[] {
  return repoReferencesIn(text).slice(0, ASSIGNMENT_REPOS_CAP);
}

/** What the row knows about work that lives outside the bound project. */
export interface CrossRepoReading {
  /** A stamp, when the agent recorded one. The (a) half — a positive, checkable claim. */
  stamp?: LandedElsewhere;
  /** The repo the ASSIGNMENT named, when it differs from the bound project. The (b) half — evidence
   *  that this row is unmeasurable from here, and no claim at all about how far it got. */
  assignedRepo?: string;
}

/** Does this row's work live outside the bound project, by either signal? */
export function isCrossRepo(reading: CrossRepoReading | undefined): boolean {
  return !!reading && (reading.stamp !== undefined || reading.assignedRepo !== undefined);
}

/**
 * The reading for one agent: its stamp (if any) plus the guard applied to its assignment text.
 *
 * `taskText` should be the agent's ASSIGNMENT — a worker's `task`, or a build agent's most recent
 * prompt. Both are what a human typed or an orchestrator wrote to define the work, which is exactly
 * where a "do this in the other repo" instruction lives.
 */
export function crossRepoReading(input: {
  landedElsewhere?: LandedElsewhere;
  /** A WORKER'S ONE-SHOT `task`, which is frozen at spawn and is therefore already durable. Never a
   *  build agent's current prompt — see {@link assignmentRepos} for why that oscillates. */
  taskText?: string | null;
  /** The latched {@link assignmentRepos} from this agent's OPENING prompt, for a build agent that
   *  has no `task`. Already normalized slugs; still compared against `boundSlug` here. */
  assignmentRepos?: readonly string[] | null;
  boundSlug?: string | null;
}): CrossRepoReading {
  const reading: CrossRepoReading = {};
  if (input.landedElsewhere) reading.stamp = input.landedElsewhere;
  // The guard runs EVEN WHEN A STAMP EXISTS. The two answer different questions — "where was this
  // work assigned" and "where did it land" — and they can honestly disagree (an agent assigned in
  // repo A that landed a prerequisite in repo B). Suppressing one because the other is present
  // would throw away the disagreement rather than showing it.
  //
  // BOTH INPUTS ARE DURABLE BY CONSTRUCTION. `taskText` is frozen at spawn; `assignmentRepos` was
  // latched from the opening prompt. Neither moves when the human types again, which is what keeps
  // the rung a function of the WORK rather than of the conversation.
  const bound = normalizeRepoSlug(input.boundSlug);
  const assigned =
    detectCrossRepoTarget(input.taskText, input.boundSlug) ??
    (bound ? (input.assignmentRepos ?? []).find((r) => r !== bound) : undefined) ??
    null;
  if (assigned) reading.assignedRepo = assigned;
  return reading;
}

/** The fields {@link crossRepoAccessors} needs off an agent row. A structural subset of `AgentTab`,
 *  declared here so this module stays free of the app's own types and stays unit-testable. */
export interface CrossRepoAgentRecord {
  id: string;
  parentId?: string | null;
  /** A worker's one-shot task, frozen at spawn. */
  task?: string | null;
  /** The latched {@link assignmentRepos} from a build agent's opening prompt. */
  assignmentRepos?: readonly string[] | null;
  landedElsewhere?: LandedElsewhere;
}

/**
 * THE ONE PLACE A FLEET'S CROSS-REPO READINGS ARE BUILT — both the per-row answer and the head's
 * subtree roll-up, from one pass over one list.
 *
 * IT IS A SHARED FUNCTION RATHER THAN A CONVENTION BECAUSE THE CONVENTION FAILED. `groupAgentsByStage`
 * documents that every caller must derive this accessor identically, and the first cut of this
 * feature updated only ONE of its three callers — leaving `ladderSelection.firstLadderRowId` and the
 * concierge's `sidebarView.columnView` computing a cross-repo row in `local_none` while the column
 * put it in `tracked_elsewhere` (roborev 67500). That matters more here than for the other
 * accessors: `tracked_elsewhere` is ladder SLOT 0, so a disagreement moves the row to the very TOP of
 * the rendered order, and `firstRenderedRowId` then hands selection to a row that is not the first
 * one on screen. A shared builder is what makes "all three agree" a fact rather than a request.
 *
 * `head` mirrors `headStageOf` / `headHoldsWorkOf`: a head is bucketed by its least-advanced worker,
 * so answering from its own record alone would file a head under "Local: Nothing Yet" while a worker
 * beneath it did all its work in another repo. Own reading first — it is the row being described.
 */
export function crossRepoAccessors(
  agents: readonly CrossRepoAgentRecord[],
  boundSlug: string | null | undefined,
): {
  own: (id: string) => CrossRepoReading | undefined;
  head: (id: string) => CrossRepoReading | undefined;
} {
  const byAgent = new Map<string, CrossRepoReading>();
  const childIds = new Map<string, string[]>();
  for (const a of agents) {
    const reading = crossRepoReading({
      ...(a.landedElsewhere ? { landedElsewhere: a.landedElsewhere } : {}),
      taskText: a.task ?? null,
      assignmentRepos: a.assignmentRepos ?? null,
      boundSlug,
    });
    if (isCrossRepo(reading)) byAgent.set(a.id, reading);
    if (a.parentId) {
      const arr = childIds.get(a.parentId);
      if (arr) arr.push(a.id);
      else childIds.set(a.parentId, [a.id]);
    }
  }
  const own = (id: string): CrossRepoReading | undefined => byAgent.get(id);
  const head = (id: string): CrossRepoReading | undefined => {
    const mine = byAgent.get(id);
    if (mine) return mine;
    for (const kid of childIds.get(id) ?? []) {
      const k = byAgent.get(kid);
      if (k) return k;
    }
    return undefined;
  };
  return { own, head };
}
