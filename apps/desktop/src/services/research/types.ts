// THE RESEARCH TASK CONTRACT — the one shape the Rust runner writes and every TypeScript consumer
// reads. Bead `sparkle-s7rfc`.
//
// ══ WHY THIS FILE EXISTS SEPARATELY FROM ITS CONSUMERS ══════════════════════════════════════════
//
// Four things are being built against this shape at once — the Rust runner (`src-tauri/src/
// research.rs`), the concierge tool domain (`conciergeTools/research.ts`), the sidebar row
// (`components/ConciergeAgentsRow.tsx`) and the turn-start drain (`ConciergeHost`/
// `conciergeProactive`). AGENTS.md records what happens when halves of a Rust→TS payload are built
// in parallel against a field list rather than a shared artifact: *both suites passed, the merge was
// clean, and the shipped feature never once ran.*
//
// So the contract is a FILE, not a list in a plan, and it ships with a fixture that BOTH suites
// parse — the Rust test asserting serde produces it and the TS test asserting this module accepts
// it, so they fail together rather than drifting apart quietly. The fixture is:
//
//     apps/desktop/src/services/research/fixtures/researchTasks.sample.json
//
// THAT EXACT PATH, spelled out because this comment is read as an instruction. An earlier version of
// this header named `researchTask.sample.json` (singular) — a file that does not exist — while four
// units were being built against it (roborev 61551). The Rust side should reference it via
// `include_str!("../../src/services/research/fixtures/researchTasks.sample.json")` so that MOVING it
// is a compile error rather than a silent divergence in which only one half still checks anything.
//
// ══ EVERY Option-BACKED FIELD IS `T | null`, NEVER `T?` ═════════════════════════════════════════
//
// This is the rule the repo has already paid for once. serde's derive emits the key with a `null`
// value for `Option::None`; it omits the key ONLY under
// `#[serde(skip_serializing_if = "Option::is_none")]`, which the Rust struct backing this
// deliberately does NOT use. TypeScript's `field?: T` means `T | undefined`, which does not include
// `null` — so a parser written against `findings?: string` describes a shape the wire cannot
// produce, and a fixture written to match it (key omitted) tests a case that never occurs.
//
// The failure mode is SILENCE: an all-or-nothing parse that rejects one field discards the whole
// payload and falls back to "we did not look". Since `None` is what the common case sends
// (`findings` is null for every task that is still running), the feature would be inert permanently,
// for everyone, with nothing logged.
//
// Therefore: `T | null` on every optional field, `null` present in the fixture, and
// `null`-and-absent treated as equivalent at every read site.

/**
 * Where a task is in its life.
 *
 * A CLOSED union, and the terminal states are deliberately three rather than one. "the shell came
 * back non-zero", "the human killed it" and "it ran out of wall clock" are different facts to the
 * concierge deciding whether to re-ask, and collapsing them into `failed` would make a cancelled
 * task look like a broken one — which is how a concierge ends up silently re-dispatching work the
 * founder just stopped.
 */
export const RESEARCH_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];

/**
 * The two tiers (founder's decision: cheap by default, escalate on demand).
 *
 * `quick` is what every dispatch gets unless the concierge asks otherwise. `deep` is the escalation
 * for when a quick pass came back thin — a bigger model and a longer wall clock, not a different
 * mechanism.
 */
export const RESEARCH_DEPTHS = ["quick", "deep"] as const;
export type ResearchDepth = (typeof RESEARCH_DEPTHS)[number];

/**
 * THE PARTITION. Every status is either still going or finished — there is no third thing, and this
 * `switch` is what makes that true at compile time.
 *
 * It replaces two independent membership lists (roborev 61551). Those lists did not partition the
 * union and nothing forced them to: adding a sixth status left it neither live nor terminal, so it
 * was uncounted by the row's `+[n]` AND never drained, with the whole suite green — the
 * "guard enumerated by value goes stale" shape. Here, a new variant fails `tsc` on the
 * `never` assignment until someone decides which phase it belongs to.
 */
export type ResearchPhase = "live" | "terminal";

export function phaseOf(status: ResearchStatus): ResearchPhase {
  switch (status) {
    case "queued":
    case "running":
      return "live";
    case "done":
    case "failed":
    case "cancelled":
      return "terminal";
    default: {
      const unreachable: never = status;
      throw new Error(`unhandled research status: ${String(unreachable)}`);
    }
  }
}

/** A task in one of these will never change again. Derived, never enumerated. */
export const TERMINAL_RESEARCH_STATUSES: readonly ResearchStatus[] = RESEARCH_STATUSES.filter(
  (s) => phaseOf(s) === "terminal",
);

export function isTerminal(status: ResearchStatus): boolean {
  return phaseOf(status) === "terminal";
}

/** The complement of {@link isTerminal}, by construction rather than by a second list. */
export function isLivePhase(status: ResearchStatus): boolean {
  return phaseOf(status) === "live";
}

/**
 * One research task, exactly as it sits on disk at `<app_data>/research/<id>.json` and exactly as
 * the Rust struct serialises.
 *
 * Read the header before adding a field: an `Option` on the Rust side is `T | null` here, never
 * `T?`, and the fixture must carry the `null`.
 */
export interface ResearchTask {
  /** Minted by the runner, never supplied by the model. */
  id: string;
  /** The question as dispatched. Verbatim — this is what the founder gets shown in the detail view. */
  question: string;
  depth: ResearchDepth;
  /**
   * The project this was asked about. `null` when the dispatch named no project and none could be
   * resolved from the selected tab — a real state, not an error: the task still runs, it just has no
   * repo to point at, and the detail view says so rather than inventing one.
   */
  projectId: string | null;
  /** Absolute path the child runs in. Resolved app-side from `projectId`, never from the model. */
  projectRoot: string;
  status: ResearchStatus;
  /** Epoch ms. Set at dispatch, before any process exists — so a task that never starts is still a
   *  task, with a time, rather than a gap. */
  createdAt: number;
  /** When a pool permit was acquired and the child actually spawned. `null` while queued. */
  startedAt: number | null;
  /** When it reached a terminal state. `null` until then. */
  finishedAt: number | null;
  /**
   * The findings. `null` unless `status === "done"`.
   *
   * NOT truncated on write. The row's detail view is what renders it, and a clipped finding is a
   * confidently-wrong answer — strictly worse than a long one the reader can scroll.
   */
  findings: string | null;
  /**
   * Why it failed, in a sentence fit to show a human. `null` unless `status === "failed"`.
   *
   * Populated from the CLI's `is_error`, never from its exit status or `subtype` — `claude_oneshot`
   * documents that both of those lie (a failed call exits 0 and still reports `"success"`), and a
   * runner that trusted either would file "Not logged in · Please run /login" as a research finding.
   */
  error: string | null;
  /**
   * THE CLAIM. Epoch ms when this task's result was folded into a concierge turn that actually
   * RESOLVED — `null` means still unread.
   *
   * Peek must never claim. This is set after `invoke("concierge_turn")` resolves, never when the
   * preamble is built: a turn that dies mid-flight must leave the finding unread so it comes back
   * next turn. That ordering is the entire reason "the result is never dropped" is a property rather
   * than a hope, and there is a test pinning it.
   */
  readAt: number | null;
}

// ---------------------------------------------------------------------------------------------
// The runtime validator — the thing that actually pins the contract
// ---------------------------------------------------------------------------------------------

/**
 * How each field of {@link ResearchTask} may arrive on the wire.
 *
 * ══ THIS RECORD IS THE GUARD, AND IT IS KEYED ON `keyof ResearchTask` ON PURPOSE ════════════════
 *
 * The first version of the seam guard asserted things about the FIXTURE and nothing about this
 * module (roborev 61551). That made it vacuous in the precise way this repo keeps paying for:
 * changing `findings: string | null` to `findings?: string` left every test AND `tsc` green, because
 * `expect(task[field]).not.toBe(undefined)` typechecks perfectly well against `string | undefined`.
 * The guard could only ever catch someone editing the fixture — never someone editing the type it
 * exists to protect.
 *
 * `Record<keyof ResearchTask, FieldKind>` fixes that by construction: rename, add or remove a field
 * on the interface and THIS FILE stops compiling until the spec is updated, which in turn drives the
 * validator and the test. The check is no longer a list someone has to remember to extend.
 */
type FieldKind =
  /** Must be present and non-null. */
  | "required"
  /** Must be PRESENT, and may be null — the `Option<T>` fields. Never absent. See the header. */
  | "nullable";

export const RESEARCH_TASK_FIELDS: Record<keyof ResearchTask, FieldKind> = {
  id: "required",
  question: "required",
  depth: "required",
  projectId: "nullable",
  projectRoot: "required",
  status: "required",
  createdAt: "required",
  startedAt: "nullable",
  finishedAt: "nullable",
  findings: "nullable",
  error: "nullable",
  readAt: "nullable",
};

/** The `Option<T>`-backed field names, derived from the spec rather than restated beside it. */
export const OPTION_BACKED_FIELDS = (
  Object.keys(RESEARCH_TASK_FIELDS) as (keyof ResearchTask)[]
).filter((f) => RESEARCH_TASK_FIELDS[f] === "nullable");

export class ResearchTaskParseError extends Error {}

/**
 * Parse one task off the wire, REJECTING the shapes the wire cannot legally produce.
 *
 * Two rejections carry the whole contract:
 *
 *   • a `nullable` field that is ABSENT — serde emits `"findings": null` for `None` and omits the
 *     key only under `skip_serializing_if`, which the Rust struct does not use. An absent key means
 *     the Rust side changed in a way the TS side was never told about, and failing loudly here beats
 *     the documented alternative: an all-or-nothing parse that discards the payload, falls back to
 *     "we did not look", and leaves the feature permanently inert with nothing logged.
 *   • a `required` field that is absent or null — i.e. a field renamed on the Rust side.
 *
 * `undefined` is the tell for both, which is why `in` is used rather than a truthiness check: `null`
 * and `absent` are different facts here, and only one of them is legal.
 */
export function parseResearchTask(value: unknown): ResearchTask {
  if (typeof value !== "object" || value === null) {
    throw new ResearchTaskParseError(`expected a research task object, got ${typeof value}`);
  }
  const raw = value as Record<string, unknown>;

  for (const field of Object.keys(RESEARCH_TASK_FIELDS) as (keyof ResearchTask)[]) {
    const kind = RESEARCH_TASK_FIELDS[field];
    if (!(field in raw) || raw[field] === undefined) {
      throw new ResearchTaskParseError(
        kind === "nullable"
          ? `\`${field}\` is absent — an Option field must arrive as an explicit null, never a missing key`
          : `\`${field}\` is missing`,
      );
    }
    if (kind === "required" && raw[field] === null) {
      throw new ResearchTaskParseError(`\`${field}\` is null, but it is required`);
    }
  }

  const status = raw.status as ResearchStatus;
  if (!RESEARCH_STATUSES.includes(status)) {
    throw new ResearchTaskParseError(`\`status\` is not a known research status: ${String(status)}`);
  }
  const depth = raw.depth as ResearchDepth;
  if (!RESEARCH_DEPTHS.includes(depth)) {
    throw new ResearchTaskParseError(`\`depth\` is not a known research depth: ${String(depth)}`);
  }

  return raw as unknown as ResearchTask;
}

/**
 * Is this task's result waiting to be told to the concierge?
 *
 * `done` only. A `failed` or `cancelled` task is surfaced in the row where the founder can see it,
 * but it is not worth spending prompt preamble on — the concierge asked for findings, and "there are
 * none" is not a finding. (A failure the founder cares about is visible in the row, which is the
 * surface he chose for exactly this.)
 */
export function isUnread(task: ResearchTask): boolean {
  return task.status === "done" && task.readAt === null && task.findings !== null;
}

/**
 * Tasks currently occupying a process or waiting for one — what the row's `+[n]` counts.
 *
 * A task-level wrapper over {@link isLivePhase}, so the membership question is answered in exactly
 * one place. It used to re-enumerate `queued`/`running` itself, which is how it and `isTerminal`
 * could drift apart without either one looking wrong.
 */
export function isLive(task: ResearchTask): boolean {
  return isLivePhase(task.status);
}
