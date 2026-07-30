// The ATTACHMENTS domain — hand an agent a FILE, not just words (concierge PRD section F).
//
// The concierge could describe a screenshot, quote a log, and paste a diff. It could not GIVE an
// agent the file, which is the one thing the human does constantly: drag a mock onto the compose
// box, drop a crash log on an agent, paste a screenshot. Every one of those routes ends in the same
// place — a path staged as a chip and prefixed onto the next message — and until now the concierge
// had no way to reach it.
//
// ---------------------------------------------------------------------------------------------
// THIS IS EXPOSURE, NOT A NEW UPLOAD STACK.
//
// The staging queue is `stores/pendingAttachmentsStore`, which already exists for files dropped on
// "+ New Build Agent" before that agent's surface did. `ConciergeHost` drains an agent's entry the
// moment the compose box is aimed at it and turns the paths into chips
// (hooks/useConciergeAttachments.attachPaths → services/conciergeAttach → the same `load_attachment`
// the human's own drop uses). From there the existing send path takes over: `buildSendPayload`
// shell-quotes the paths in front of the message body, and `buildDisplay` shows counts rather than
// temp paths, which is the leak an earlier branch spent three roborev rounds closing. Nothing here
// re-implements any of that, and nothing here sends: a staged file rides along with the NEXT message
// that agent is sent, and a human still presses send.
//
// WHAT THAT SEAM COSTS, STATED PLAINLY. `list_attachments` can see the QUEUE and not the compose
// box's chips — the box's list is React state inside `useConciergeAttachments`, unreachable from a
// service. So an empty list has two meanings ("nothing was attached" and "what was attached has
// already moved onto the box") and this module says so in words rather than letting a caller read
// the first. Inventing a second store to close that gap would have given the app two staging queues
// for one compose box, and the one nobody remembers to drain is the one that strands files.
//
// ---------------------------------------------------------------------------------------------
// AN ABSOLUTE PATH FROM A MODEL IS AN ARBITRARY FILE READ. THAT IS THE WHOLE REVIEW SURFACE.
//
// The terminal domain met this exact question and answered it by DELETION: `read_agent_terminal`
// used to accept a `transcriptPath`, and the argument was removed because "the tool argument surface
// is model-supplied, and this output lands in an LLM context window" (see the block in terminal.ts).
// Deletion is not available here — a path IS the feature — so the same standard is met by
// constraint instead, and every constraint is a named refusal rather than a silent drop:
//
//   path-not-absolute  a relative path would resolve against a cwd nobody declared.
//   path-traversal     a `..` segment, refused LEXICALLY, before the filesystem is touched at all.
//   not-found          the path does not resolve (or is unreachable).
//   not-a-file         a directory, a socket, a fifo.
//   outside-project    the RESOLVED path is not under the project root or the agent's worktree.
//   symlink-escape     it LOOKED contained and resolved somewhere else. Its own code on purpose —
//                      see `vetPath`, where the two are told apart.
//   hidden-path        a dot-prefixed segment below the root: `.env`, `.git/config`, `.ssh/id_rsa`.
//   too-large          past {@link MAX_ATTACHMENT_BYTES}.
//   too-many           past {@link MAX_STAGED_PER_AGENT} staged for one agent.
//
// THREE PROPERTIES HOLD THAT TOGETHER:
//
// 1. CONTAINMENT IS CHECKED AGAINST THE RESOLVED PATH, AND THE RESOLVED PATH IS WHAT GETS STAGED.
//    `probe_attachment` (src-tauri/src/attachments.rs) canonicalizes — symlinks and `..` gone — and
//    hands back the real path, its size, and whether it is a regular file. Staging that real path
//    rather than the model's string is what closes the check-vs-use window: a symlink swapped after
//    the check cannot redirect a send, because the send no longer names the symlink.
//    `load_attachment` cannot serve here: it echoes the path it was HANDED, which is precisely the
//    string a symlink lies with.
//
// 2. THE CALL IS ALL-OR-NOTHING. One bad path in a batch refuses the whole batch and stages none of
//    it. A partial stage would have the concierge report "attached your three files" truthfully
//    about two, and the human sends believing all three rode along — a quiet wrong answer, which is
//    worse than a loud refusal the model can retry.
//
// 3. THE ROOTS COME FROM THE STORE, NEVER FROM THE MODEL. An agent id is the only handle a caller
//    gets; the project root and the worktree are resolved here, exactly as the registry resolves
//    everything else (see the note above `locateAgent` there). A caller that could name its own
//    containment root would be naming no root at all.
//
// The Rust side keeps its OWN, wider gate (home / temp / mounted volumes, no hidden components) as
// defence in depth. It is not this module's boundary — the project root is far narrower — but it
// means a hole here is not immediately a hole in the app.
import { invoke } from "@tauri-apps/api/core";

import { isImagePath, basename } from "../../components/composer/attachments";
import { log } from "../../logger";
import { describePaths } from "../logSafePaths";
import { usePendingAttachmentsStore } from "../../stores/pendingAttachmentsStore";
import { useProjectStore } from "../../stores/projectStore";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

export const ATTACHMENTS_OPS = [
  "list_attachments",
  "attach_to_message",
  "clear_attachments",
] as const;

export type AttachmentsOp = (typeof ATTACHMENTS_OPS)[number];

export type AttachmentsRisk = "read-only" | "routine" | "disruptive" | "irreversible";

/**
 * EXHAUSTIVE by construction — `Record<AttachmentsOp, AttachmentsRisk>`, so an op added to
 * {@link ATTACHMENTS_OPS} without a classification fails `tsc` rather than defaulting to something
 * permissive. The policy layer derives its allow/ask default from this map, so it is load-bearing.
 *
 * `attach_to_message` IS A WRITE (`routine`, not `read-only`) — it changes what the next message to
 * that agent carries. It is deliberately NOT `disruptive`, and the reasoning is worth stating
 * because the nearest precedent goes the other way: `add_project_from_folder` is overridden to
 * `disruptive` in policy.ts as "the one workspace op that takes a filesystem path from the model and
 * gives it standing in the app". The difference is containment. That op accepts ANY absolute path;
 * this one accepts only a path that resolves inside the project the agent is already working in — so
 * it hands that agent nothing it could not already open for itself. Nothing is sent, the staged
 * files appear as visible chips on the compose box, and the human presses send. Asking for approval
 * per attachment would put an approval card in front of a human who is about to look at the chips
 * anyway. Anyone who disagrees sets this one tool to "Ask" in Settings → Concierge tools.
 *
 * `clear_attachments` is `routine` for the mirror reason: it un-stages files that have not been
 * sent. Nothing is deleted from disk — see {@link clearAttachments}.
 */
export const ATTACHMENTS_RISK: Record<AttachmentsOp, AttachmentsRisk> = {
  list_attachments: "read-only",
  attach_to_message: "routine",
  clear_attachments: "routine",
};

// ---------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------

/**
 * The per-file ceiling.
 *
 * Lower than Rust's `MAX_PREVIEW_BYTES` (40 MB), and not for the same reason. That number bounds
 * base64 riding an IPC message, and above it the human's own drop DEGRADES — the file still
 * attaches, it just loses its thumbnail, and a human looking at a tile can see what they picked.
 * A model-chosen path has nobody looking. The binding constraint here is the far side: the file is
 * read by the AGENT, and 10 MB of text is on the order of two million tokens — past any context
 * window, so a larger file is a context bomb whatever its type. Refusing is more useful than
 * attaching something that will be truncated or will blow up the receiving agent.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * How many files may be staged for ONE agent at a time.
 *
 * Every staged path is shell-quoted onto the FRONT of the next message (`buildSendPayload`), so an
 * unbounded queue turns one send into a multi-kilobyte command line before the human's words even
 * start. Ten is far past any real use and well short of anything a PTY line buffer notices.
 */
export const MAX_STAGED_PER_AGENT = 10;

/** How many paths one call may name. The same bound as the queue — a single call cannot fill more
 *  than the queue holds, so a caller never has to reason about two different limits. */
export const MAX_PATHS_PER_CALL = MAX_STAGED_PER_AGENT;

// ---------------------------------------------------------------------------------------------
// Refusal codes
// ---------------------------------------------------------------------------------------------

/**
 * One code per rejection reason, exported so the tests and the registry name them rather than
 * spelling string literals that drift. These are the domain's machine-readable vocabulary and pass
 * through the registry as the reply's `code` (see `fromAttachments` there).
 */
export const ATTACHMENT_REFUSALS = {
  unknownAgent: "unknown-agent",
  noProjectRoot: "no-project-root",
  noPaths: "no-paths",
  notAbsolute: "path-not-absolute",
  traversal: "path-traversal",
  notFound: "not-found",
  notAFile: "not-a-file",
  outsideProject: "outside-project",
  symlinkEscape: "symlink-escape",
  hidden: "hidden-path",
  tooLarge: "too-large",
  tooMany: "too-many",
} as const;

export type AttachmentRefusalCode =
  (typeof ATTACHMENT_REFUSALS)[keyof typeof ATTACHMENT_REFUSALS];

// ---------------------------------------------------------------------------------------------
// Results — the board/diff/plans convention
// ---------------------------------------------------------------------------------------------

export interface AttachmentsOk<T> {
  ok: true;
  op: AttachmentsOp;
  risk: AttachmentsRisk;
  data: T;
}

export interface AttachmentsRefusal {
  ok: false;
  op: AttachmentsOp;
  risk: AttachmentsRisk;
  reason: string;
  message: string;
}

export type AttachmentsResult<T> = AttachmentsOk<T> | AttachmentsRefusal;

function ok<T>(op: AttachmentsOp, data: T): AttachmentsOk<T> {
  return { ok: true, op, risk: ATTACHMENTS_RISK[op], data };
}

function refuse(op: AttachmentsOp, reason: string, message: string): AttachmentsRefusal {
  return { ok: false, op, risk: ATTACHMENTS_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

/** One staged file, as the concierge sees it. `kind` mirrors what the compose box will render —
 *  an image gets a thumbnail tile, anything else a file tile. */
export interface StagedFile {
  path: string;
  name: string;
  kind: "image" | "file";
}

export interface StagedList {
  agentId: string;
  files: StagedFile[];
  count: number;
  /** One sentence saying what this list does and does NOT establish. Always present — an EMPTY
   *  list is genuinely ambiguous here (see the header), and a caller must not read it as "nothing
   *  is attached". */
  detail: string;
}

export interface AttachOutcome {
  agentId: string;
  /** What this call added, with the RESOLVED paths that were staged (not the strings supplied). */
  attached: StagedFile[];
  /** Paths that were already queued for this agent, so the call skipped them. Not a refusal —
   *  attaching the same file twice is a mistake with an obvious right answer. */
  alreadyStaged: string[];
  /** Everything queued for this agent afterwards. */
  staged: number;
  detail: string;
}

function viewOf(path: string): StagedFile {
  return { path, name: basename(path), kind: isImagePath(path) ? "image" : "file" };
}

// ---------------------------------------------------------------------------------------------
// Path arithmetic — PURE, and separated out because it is the part worth testing directly
// ---------------------------------------------------------------------------------------------

/** A POSIX path's non-empty segments. macOS-only app, so there is no drive-letter case. */
function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

/**
 * Is `real` strictly BELOW `root`?
 *
 * Segment-wise, never `startsWith`. A prefix test on the raw strings says `/repo-secrets/x` is
 * inside `/repo`, which is the classic containment bug and would be a live hole here: the project
 * root is a real directory and a sibling directory sharing its prefix is trivially arrangeable.
 *
 * STRICTLY below — the root itself is not attachable. That costs nothing (a directory is refused as
 * `not-a-file` anyway) and keeps the predicate's meaning simple.
 *
 * Case-SENSITIVE, deliberately. macOS filesystems are usually case-insensitive, so this can refuse
 * a path that would in fact have opened; that is the safe direction, and matching case-insensitively
 * would be a widening of the gate performed on a guess about the volume's settings.
 */
export function isInsideRoot(real: string, root: string): boolean {
  const r = segments(root);
  const c = segments(real);
  if (c.length <= r.length) return false;
  return r.every((s, i) => c[i] === s);
}

/**
 * The first dot-prefixed segment of `real` BELOW `root`, or null when there is none.
 *
 * Mirrors `component_is_hidden` in src-tauri/src/attachments.rs, and exists for the same reason:
 * plain containment still exposes `.env`, `.git/config`, `.npmrc` and every other secret a repo
 * keeps in a dotfile. Only the portion below the root is examined — the root itself may perfectly
 * well live under a hidden directory (a Sparkle worktree does not, but a user's project can), and
 * judging the root would refuse every file in such a project.
 */
export function hiddenSegmentBelow(real: string, root: string): string | null {
  const r = segments(root);
  const c = segments(real);
  for (const s of c.slice(r.length)) if (s.startsWith(".")) return s;
  return null;
}

// ---------------------------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------------------------

/** What `probe_attachment` returns: the RESOLVED path, its size, and whether it is a regular file.
 *  Mirror of the Rust struct — serde renames nothing, so the field names are snake_case. */
interface ProbeWire {
  real_path: string;
  size: number;
  is_file: boolean;
}

interface Probe {
  realPath: string;
  size: number;
  isFile: boolean;
}

/** Resolve + stat one path. Rejects (rather than returning null) so the caller can tell a genuine
 *  IPC failure from a missing file — both become `not-found`, but only after the message is seen. */
async function probe(path: string): Promise<Probe> {
  const r = await invoke<ProbeWire>("probe_attachment", { path });
  return { realPath: r.real_path, size: r.size, isFile: r.is_file };
}

// ---------------------------------------------------------------------------------------------
// Resolving an agent to its containment roots
// ---------------------------------------------------------------------------------------------

function locateAgent(agentId: string) {
  for (const project of useProjectStore.getState().projects) {
    const agent = project.agents?.find((a) => a.id === agentId);
    if (agent) return { project, agent };
  }
  return null;
}

/**
 * The directories a file may come from, for THIS agent.
 *
 * Two, and the second is not a refinement of the first: a Sparkle-managed worktree lives under the
 * app's support directory, nowhere near the project the human chose. An agent's own work therefore
 * sits OUTSIDE `project.rootPath`, and a containment rule built on the project root alone would
 * refuse an agent's own build output — the single most likely thing anyone wants to attach.
 *
 * Roots are PROBED, not trusted as strings, for the same reason candidate paths are: a root that is
 * itself a symlink (or that carries a `..`) would make every comparison against it meaningless. A
 * root that cannot be resolved — a worktree already torn down — is dropped rather than fatal.
 */
async function containmentRoots(
  rootPath: string | undefined,
  worktreePath: string | null | undefined,
): Promise<Root[]> {
  const candidates = [rootPath, worktreePath].filter(
    (p): p is string => typeof p === "string" && p.trim() !== "",
  );
  /** A candidate root after resolution: either it canonicalized, or it says why it did not.
   *  Annotated explicitly so `"real" in r` NARROWS — inferred literals give both arms an optional
   *  copy of the other's key, and the `in` check then narrows nothing. */
  type Resolved = { given: string; real: string } | { given: string; error: string };
  const resolved = await Promise.all(
    candidates.map(async (given): Promise<Resolved> => {
      try {
        return { given, real: (await probe(given)).realPath };
      } catch (e) {
        // WHY THE ROOT FAILED IS PART OF THE ANSWER (roborev 55403).
        //
        // `probe_attachment` runs Rust's `validate_read_path`, which is NARROWER than "does this
        // folder exist": it rejects anything outside `$HOME`/temp/`/Volumes`, and anything with a
        // dot-prefixed component below the root. So a project living at `~/.dotfiles`,
        // `~/.config/proj` or `/opt/src/app` cannot resolve as a root at all — and the caller was
        // then told "I can't resolve this agent's project folder or worktree", which blames a
        // missing folder for what is actually an allow-list rule. It also contradicts
        // `hiddenSegmentBelow`, whose own tests say a project under a hidden directory is legal:
        // the pure function agrees, the end-to-end path refuses every file.
        //
        // The real fix is a probe that canonicalizes a directory without applying the read
        // allow-list; until that exists, the failure is at least CARRIED rather than flattened, so
        // `attach_to_message` can say which of the two happened instead of guessing.
        return { given, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const seen = new Set<string>();
  const roots: Root[] = [];
  for (const r of resolved) {
    if (!("real" in r)) {
      rootFailures.set(r.given, r.error);
      continue;
    }
    if (seen.has(r.real)) continue;
    seen.add(r.real);
    roots.push(r);
  }
  return roots;
}

/** Why a candidate root could not be resolved, keyed by the path as configured.
 *
 *  Module-level and last-write-wins: it exists so the `no-project-root` refusal can quote the real
 *  reason, and it is read immediately after the resolve that filled it. */
const rootFailures = new Map<string, string>();

/** The reason the most recent resolve rejected `given`, if it did. */
export function rootFailureReason(given: string | undefined | null): string | undefined {
  return given ? rootFailures.get(given) : undefined;
}

/**
 * One containment root, in both spellings.
 *
 * `real` is THE gate — every containment decision is made against it and nothing else. `given` is
 * kept only to CLASSIFY a refusal: when the project folder is itself reached through a link, a
 * caller's path can look contained against `given` while matching neither root once resolved, and
 * without `given` that lands on `outside-project` when `symlink-escape` is the true story. Using
 * `given` for the gate itself would defeat the entire module.
 */
interface Root {
  given: string;
  real: string;
}

// ---------------------------------------------------------------------------------------------
// Vetting one path
// ---------------------------------------------------------------------------------------------

type Vetted =
  | { ok: true; realPath: string }
  | { ok: false; code: AttachmentRefusalCode; why: string };

/**
 * Run one model-supplied path through every constraint, in the order that lets each refusal say
 * something TRUE about what went wrong.
 *
 * The ordering is the design. Lexical checks come first so `../../etc/passwd` is refused as
 * `path-traversal` — naming the actual defect — instead of being canonicalized into `/etc/passwd`
 * and reported as merely "outside the project", which reads as a location problem rather than an
 * attempted escape. Existence comes before containment for the same reason: "there is no such file"
 * is a more useful sentence than "that isn't in your project" about a path that isn't anywhere.
 *
 * WHY `symlink-escape` IS A SEPARATE CODE. It is the one rejection where the string the caller sent
 * and the thing it points at disagree. Reporting `outside-project` for `<root>/notes/link.txt` would
 * tell a caller its path was outside a directory it visibly starts with — which reads as a broken
 * tool, invites a retry with the same path, and hides the only fact that matters.
 */
async function vetPath(raw: string, roots: readonly Root[]): Promise<Vetted> {
  const path = raw.trim();
  if (!path.startsWith("/")) {
    return {
      ok: false,
      code: ATTACHMENT_REFUSALS.notAbsolute,
      why: "not an absolute path — there is no working directory to resolve it against",
    };
  }
  if (segments(path).includes("..")) {
    return {
      ok: false,
      code: ATTACHMENT_REFUSALS.traversal,
      why: "contains a `..` segment, which is not accepted even when it would resolve somewhere legitimate",
    };
  }

  // LEXICAL CONTAINMENT FIRST, BEFORE THE FILESYSTEM IS TOUCHED (roborev 55403).
  //
  // Probing first made this an existence-and-type ORACLE over everything the Rust gate admits — the
  // user's whole non-dot `$HOME`, `$TMPDIR`, `/Volumes` — because `not-found`, `not-a-file` and
  // `outside-project` are deliberately different codes. The concierge reads agent terminal output,
  // so a prompt-injected instruction could walk the home tree by refusal code alone without ever
  // attaching anything. It also undercut the reasoning one block down, where `symlink-escape`
  // withholds the resolved target precisely so the refusal is not a read oracle.
  //
  // A path that is lexically outside every root can be refused on the string alone, so it is. Paths
  // that LOOK contained are still probed, which keeps `symlink-escape`, `not-found` and `not-a-file`
  // exactly as informative as before for the only paths a caller is entitled to ask about.
  const lexicallyInside = roots.some(
    (r) => isInsideRoot(path, r.real) || isInsideRoot(path, r.given),
  );
  if (!lexicallyInside) {
    return {
      ok: false,
      code: ATTACHMENT_REFUSALS.outsideProject,
      why: "is not inside this agent's project or worktree",
    };
  }

  let found: Probe;
  try {
    found = await probe(path);
  } catch (e) {
    return {
      ok: false,
      code: ATTACHMENT_REFUSALS.notFound,
      why: `cannot be read (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  if (!found.isFile) {
    return {
      ok: false,
      code: ATTACHMENT_REFUSALS.notAFile,
      why: "is not a regular file — a directory can't ride along with a message",
    };
  }

  // THE GATE, and it asks only `r.real` — see the note on `Root`.
  const home = roots.find((r) => isInsideRoot(found.realPath, r.real));
  if (!home) {
    // The lexical path looked contained and the RESOLVED one is not: a link (or a mount) pointing
    // out of the project. Named separately — see the doc comment. Both spellings of the root are
    // consulted HERE (and only here): this decides which sentence to say, not whether to allow.
    const lookedContained = roots.some(
      (r) => isInsideRoot(path, r.real) || isInsideRoot(path, r.given),
    );
    return lookedContained
      ? {
          ok: false,
          code: ATTACHMENT_REFUSALS.symlinkEscape,
          // The TARGET is deliberately not named. Saying where it resolved would turn this refusal
          // into a read oracle for link targets outside the project — the caller could plant, or
          // simply find, a link and learn what it points at without ever attaching anything. The
          // caller supplied the path it sent; it does not get told what the app found behind it.
          why: "looks like it is in the project but resolves, through a link, to somewhere outside it",
        }
      : {
          ok: false,
          code: ATTACHMENT_REFUSALS.outsideProject,
          why: "is outside this agent's project and worktree — I can only attach files from the project the agent is working in",
        };
  }

  const hidden = hiddenSegmentBelow(found.realPath, home.real);
  if (hidden) {
    return {
      ok: false,
      code: ATTACHMENT_REFUSALS.hidden,
      why: `reaches a hidden path (\`${hidden}\`) — dot-prefixed files and folders hold credentials and repo internals, so they are never attachable`,
    };
  }

  if (found.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      code: ATTACHMENT_REFUSALS.tooLarge,
      why: `is ${Math.round(found.size / (1024 * 1024))} MB, over the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit`,
    };
  }
  // The RESOLVED path, not the one that was supplied — see property 1 in the header.
  return { ok: true, realPath: found.realPath };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

function stagedFor(agentId: string): string[] {
  return usePendingAttachmentsStore.getState().pending[agentId] ?? [];
}

/** Why an empty list is not the same as "nothing is attached". See the header. */
const EMPTY_DETAIL =
  "Nothing is queued for this agent. That does NOT mean nothing is attached: files move out of " +
  "this queue and onto the compose box as chips as soon as the box is aimed at this agent, and " +
  "the box's own chips aren't readable from here. Say what this list shows, not what it implies.";

/** What is staged for one agent, and what that does and does not establish. */
export function listAttachments(agentId: string): AttachmentsResult<StagedList> {
  if (!locateAgent(agentId)) return unknownAgent("list_attachments", agentId);
  const files = stagedFor(agentId).map(viewOf);
  return ok("list_attachments", {
    agentId,
    files,
    count: files.length,
    detail:
      files.length === 0
        ? EMPTY_DETAIL
        : `${files.length} file(s) are queued and will land on the compose box as chips the moment it is aimed at this agent. They ride along with the next message it is sent.`,
  });
}

function unknownAgent(op: AttachmentsOp, agentId: string): AttachmentsRefusal {
  return refuse(
    op,
    ATTACHMENT_REFUSALS.unknownAgent,
    `I can't find an agent with id ${agentId} in any open project — it may already be closed. ` +
      `Re-read the roster for a current id.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/**
 * Stage files to ride along with the next message this agent is sent.
 *
 * ALL-OR-NOTHING: if any path is rejected, nothing is staged and the refusal names every rejection.
 * See property 2 in the header for why a partial stage is the worse failure.
 */
export async function attachToMessage(
  agentId: string,
  rawPaths: readonly string[],
): Promise<AttachmentsResult<AttachOutcome>> {
  const found = locateAgent(agentId);
  if (!found) return unknownAgent("attach_to_message", agentId);

  // De-duplicated within the call, so naming the same file twice is one attachment rather than a
  // `too-many` refusal the caller can't see the cause of.
  const paths = [...new Set(rawPaths.map((p) => (typeof p === "string" ? p.trim() : "")))].filter(
    (p) => p !== "",
  );
  if (paths.length === 0) {
    return refuse(
      "attach_to_message",
      ATTACHMENT_REFUSALS.noPaths,
      "No paths to attach — name at least one absolute path inside the agent's project.",
    );
  }
  if (paths.length > MAX_PATHS_PER_CALL) {
    return refuse(
      "attach_to_message",
      ATTACHMENT_REFUSALS.tooMany,
      `That's ${paths.length} files; I can attach at most ${MAX_PATHS_PER_CALL} at once.`,
    );
  }

  const roots = await containmentRoots(found.project.rootPath, found.agent.worktreePath);
  if (roots.length === 0) {
    // SAY WHICH OF THE TWO HAPPENED. "The folder isn't there" and "the folder is there but the
    // app's read policy won't canonicalize it" lead to completely different actions, and the
    // second is what a project under a hidden directory or outside $HOME actually hits
    // (roborev 55403). Quoting the resolver's own words beats inventing a diagnosis.
    const why = [found.project.rootPath, found.agent.worktreePath]
      .map((p) => (p ? rootFailureReason(p) : undefined))
      .find((m): m is string => typeof m === "string" && m !== "");
    return refuse(
      "attach_to_message",
      ATTACHMENT_REFUSALS.noProjectRoot,
      "I can't resolve this agent's project folder or worktree, so I have nothing to check a path " +
        "against — and I won't attach a file without one." +
        (why ? ` The folder was rejected rather than missing: ${why}` : ""),
    );
  }

  const verdicts = await Promise.all(paths.map((p) => vetPath(p, roots)));
  const rejected = paths
    .map((p, i) => ({ path: p, verdict: verdicts[i]! }))
    .filter((r): r is { path: string; verdict: Extract<Vetted, { ok: false }> } => !r.verdict.ok);
  if (rejected.length > 0) {
    const first = rejected[0]!.verdict.code;
    const lines = rejected.map((r) => `\`${r.path}\` ${r.verdict.why}`).join("; ");
    return refuse(
      "attach_to_message",
      first,
      `I didn't attach anything — ${rejected.length} of ${paths.length} path(s) were refused, and I ` +
        `stage a batch only if all of it passes. ${lines}.`,
    );
  }

  // De-duplicated AGAIN, on the resolved paths. The earlier de-duplication was over the strings the
  // caller sent, and two different strings can name one file — a link and its target, or the same
  // file reached through two links. Without this, that file is staged twice and prefixed onto the
  // message twice.
  const real = [...new Set(verdicts.map((v) => (v.ok ? v.realPath : "")))];
  const already = stagedFor(agentId);
  const fresh = real.filter((p) => !already.includes(p));
  if (already.length + fresh.length > MAX_STAGED_PER_AGENT) {
    return refuse(
      "attach_to_message",
      ATTACHMENT_REFUSALS.tooMany,
      `That agent already has ${already.length} file(s) queued; ${fresh.length} more would pass the ` +
        `limit of ${MAX_STAGED_PER_AGENT}. Send what's queued, or clear it with clear_attachments.`,
    );
  }

  if (fresh.length > 0) {
    usePendingAttachmentsStore.getState().add(agentId, fresh);
    // Kinds and counts, never paths — this log ships with support tickets (services/logSafePaths).
    log.info("concierge-tools", `staged ${fresh.length} file(s) for an agent's next message`, {
      agentId,
      ...describePaths(fresh),
    });
  }

  const staged = already.length + fresh.length;
  return ok("attach_to_message", {
    agentId,
    attached: fresh.map(viewOf),
    alreadyStaged: real.filter((p) => already.includes(p)),
    staged,
    detail:
      `Staged. ${staged} file(s) are queued for this agent and will appear as chips on the compose ` +
      `box once it is aimed there; they ride along with the next message it is sent. Nothing has ` +
      `been sent — a human still presses send.`,
  });
}

/**
 * Un-stage everything queued for an agent.
 *
 * NOTHING IS DELETED FROM DISK. This drops paths out of the queue; the files themselves are the
 * human's own project files and are untouched, which is what keeps this `routine` rather than
 * `irreversible`. It also cannot un-stage a chip that has already reached the compose box — the same
 * seam `list_attachments` reports, and the reason the result says how many it actually took.
 */
export function clearAttachments(
  agentId: string,
): AttachmentsResult<{ agentId: string; cleared: number; detail: string }> {
  if (!locateAgent(agentId)) return unknownAgent("clear_attachments", agentId);
  const cleared = usePendingAttachmentsStore.getState().drain(agentId).length;
  return ok("clear_attachments", {
    agentId,
    cleared,
    detail:
      cleared === 0
        ? "There was nothing queued to clear. Files already moved onto the compose box are chips " +
          "the human removes there — I can't take those back."
        : `Cleared ${cleared} queued file(s). Nothing was deleted from disk.`,
  });
}
