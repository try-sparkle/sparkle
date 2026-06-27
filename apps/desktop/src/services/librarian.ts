// librarian — the background "librarian + skeptic" grounding service for the Think interview.
//
// While the user is being interviewed, this runs Chief in parallel and NEVER blocks the chat:
// every query is fire-and-forget, debounced, and fully swallows its own errors. Two lanes fire
// per (debounced) user turn against the project's Chief library, both at `fast` intelligence:
//   • LIBRARIAN  — surfaces the most relevant prior decisions/docs + any collisions with what's
//                  already decided, citing doc names as markdown links.
//   • SKEPTIC    — argues the strongest counter-case grounded in the project's history (a persona
//                  skill, ensured once per Chief project).
// Results land in `librarianStore` lane-by-lane as each resolves; the interview reads them when it
// wants and is otherwise unaffected. A newer turn aborts the in-flight queries (an abort is not an
// error). Built as a dependency-injected factory so tests drive it with fakes + fake timers and
// never touch real Chief or wall-clock timers.
import type { ChatOptions, ChiefScope } from "./chief";
import type { LibrarianItem } from "../stores/librarianStore";

export interface LibrarianDeps {
  startChat: typeof import("./chief").startChat;
  pollForResponse: typeof import("./chief").pollForResponse;
  ensureSkill: typeof import("./chief").ensureSkill;
  setLane(agentId: string, lane: "grounding" | "challenges", items: LibrarianItem[]): void;
  setStatus(agentId: string, status: "idle" | "thinking" | "error"): void;
  /** Trailing-debounce window for coalescing rapid turns. Default 800ms. */
  debounceMs?: number;
  /** Clock for item timestamps — injectable so tests get deterministic `ts`. Default Date.now. */
  now?: () => number;
}

export interface TurnContext {
  agentId: string;
  pat: string;
  chiefProjectId: string;
  /** The interview-so-far the two lanes reason over (already formatted by the caller). */
  conversation: string;
  /** Optional Chief concept ids to narrow retrieval; omitted from scope when empty. */
  conceptIds?: string[];
}

export interface Librarian {
  onUserTurn(ctx: TurnContext): void;
  dispose(): void;
}

export const SKEPTIC_SKILL_NAME = "sparkle-skeptic";

/** Persona instructions for the skeptic skill (ensured once per Chief project). */
export const SKEPTIC_INSTRUCTIONS = [
  "You are a rigorous, project-grounded skeptic embedded in a product-planning interview.",
  "Your job is to stress-test the current direction using THIS project's own history, not generic",
  "objections. Cite prior decisions, docs, and prior art that already exists in the project. Argue",
  "the strongest honest counter-case: what is being underweighted, which risks are unaddressed,",
  "what similar prior attempts struggled or failed, and where the new idea collides with something",
  "already decided. Be specific and terse. Never hedge into both-sides mush; make the sharpest",
  "case the evidence supports. Never block or stall the conversation — you are advisory only.",
].join(" ");

/** Librarian lane prompt: terse, grounded, doc-citing, <=5 bullets. */
export function LIBRARIAN_PROMPT(conversation: string): string {
  return [
    "You are the project librarian for an ongoing planning interview.",
    "From THIS project's library only, surface the most relevant prior decisions and documents,",
    "and flag any collisions or overlaps with what has already been decided.",
    "Respond as <=5 terse bullets. Cite each doc by name as a markdown link [Doc name](doc).",
    "No preamble, no conclusion — bullets only. If nothing relevant exists, say so in one line.",
    "",
    "Interview so far:",
    conversation,
  ].join("\n");
}

/** Skeptic lane prompt: strongest counter-case grounded in project history, <=5 bullets. */
export function SKEPTIC_PROMPT(conversation: string): string {
  return [
    "Argue the strongest counter-case against the current direction, grounded ONLY in this",
    "project's history: surfaced risks, prior art that struggled or failed, and what is being",
    "underweighted. Respond as <=5 terse bullets. Cite supporting docs as markdown links",
    "[Doc name](doc) where they exist. No preamble, no conclusion — bullets only.",
    "",
    "Interview so far:",
    conversation,
  ].join("\n");
}

const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

/** Pull every markdown link target `[text](url)` out of a chunk of text. */
function extractDocRefs(text: string): string[] {
  const refs: string[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const target = m[1]?.trim();
    if (target) refs.push(target);
  }
  return refs;
}

/**
 * Parse a Chief markdown response into discrete findings. Pure (no I/O) so it's unit-testable.
 * Splits on bullet/numbered lines when present, else on blank-line-separated paragraphs; each
 * resulting chunk becomes one `LibrarianItem` carrying any markdown-link targets as `docRefs`.
 */
export function parseFindings(markdown: string, now: number): LibrarianItem[] {
  const text = (markdown ?? "").trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const hasBullets = lines.some((l) => BULLET_RE.test(l));

  const chunks = hasBullets
    ? lines.filter((l) => BULLET_RE.test(l)).map((l) => l.replace(BULLET_RE, ""))
    : text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " "));

  const items: LibrarianItem[] = [];
  for (const raw of chunks) {
    const cleaned = raw.replace(/^#{1,6}\s+/, "").trim();
    if (!cleaned) continue;
    items.push({ text: cleaned, docRefs: extractDocRefs(cleaned), ts: now });
  }
  return items;
}

/**
 * Create a librarian instance. `onUserTurn` debounces and, on fire, runs the two lanes in
 * parallel against Chief; `dispose` tears down any pending timer + in-flight queries. The factory
 * holds no module-level state, so each interview/agent owns an isolated instance.
 */
export function createLibrarian(deps: LibrarianDeps): Librarian {
  const debounceMs = deps.debounceMs ?? 800;
  const now = deps.now ?? Date.now;
  // Chief projects whose skeptic persona skill we've already ensured (so we don't re-ensure every
  // turn). Per-project, not per-turn — the skill is idempotent but the round-trip isn't free.
  const ensuredSkillProjects = new Set<string>();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function abortInflight(): void {
    if (inflight) {
      inflight.abort();
      inflight = null;
    }
  }

  // Run one lane end-to-end: start a chat, poll (honoring the abort signal), parse, publish. Any
  // failure rejects so the caller's allSettled can count it; an abort surfaces as a rejection too.
  async function runLane(
    ctx: TurnContext,
    signal: AbortSignal,
    lane: "grounding" | "challenges",
    prompt: string,
    opts: ChatOptions,
  ): Promise<void> {
    const { chat_id, message_id } = await deps.startChat(ctx.pat, ctx.chiefProjectId, prompt, opts);
    const markdown = await deps.pollForResponse(ctx.pat, ctx.chiefProjectId, chat_id, message_id, {
      signal,
    });
    // A newer turn may have aborted us AFTER this poll resolved: the real `pollForResponse` only
    // checks the signal at the top of each poll iteration, so once a response is in hand it resolves
    // even if the signal fired mid-iteration. Without this guard a stale turn could overwrite the
    // current turn's lane with old findings. Bail before publishing when superseded.
    if (signal.aborted) return;
    deps.setLane(ctx.agentId, lane, parseFindings(markdown, now()));
  }

  async function fire(ctx: TurnContext): Promise<void> {
    const ctrl = new AbortController();
    inflight = ctrl;
    try {
      deps.setStatus(ctx.agentId, "thinking");

      const scope: ChiefScope = { project_ids: [ctx.chiefProjectId] };
      if (ctx.conceptIds && ctx.conceptIds.length > 0) scope.concept_ids = ctx.conceptIds;

      // Ensure the skeptic persona once per Chief project (best-effort — a failure just means the
      // skeptic lane runs without the persona this turn, and we'll retry the ensure next turn).
      let skepticSkillReady = ensuredSkillProjects.has(ctx.chiefProjectId);
      if (!skepticSkillReady) {
        try {
          await deps.ensureSkill(
            ctx.pat,
            ctx.chiefProjectId,
            SKEPTIC_SKILL_NAME,
            SKEPTIC_INSTRUCTIONS,
            "persona",
          );
          ensuredSkillProjects.add(ctx.chiefProjectId);
          skepticSkillReady = true;
        } catch {
          // best-effort; proceed without the skill this turn
        }
      }
      // A newer turn may have aborted us while we awaited the ensure — bail without touching state.
      if (ctrl.signal.aborted) return;

      const baseOpts: ChatOptions = { intelligence: "fast", scope };
      const skepticOpts: ChatOptions = skepticSkillReady
        ? { ...baseOpts, skills: [SKEPTIC_SKILL_NAME] }
        : baseOpts;

      // Fire both lanes; each publishes independently as it resolves (don't wait for the other).
      const results = await Promise.allSettled([
        runLane(ctx, ctrl.signal, "grounding", LIBRARIAN_PROMPT(ctx.conversation), baseOpts),
        runLane(ctx, ctrl.signal, "challenges", SKEPTIC_PROMPT(ctx.conversation), skepticOpts),
      ]);

      // Aborted by a newer turn: that turn now owns the status — leave it untouched.
      if (ctrl.signal.aborted) return;

      const failures = results.filter((r) => r.status === "rejected").length;
      deps.setStatus(ctx.agentId, failures === results.length ? "error" : "idle");
    } catch {
      // Defensive: a background grounding query must NEVER break the interview. Swallow everything
      // and degrade to idle (unless a newer turn has already taken over).
      if (!ctrl.signal.aborted) {
        try {
          deps.setStatus(ctx.agentId, "error");
        } catch {
          // even the status write is non-critical — ignore
        }
      }
    } finally {
      // Only clear if we're still the current in-flight (a newer turn may have replaced us).
      if (inflight === ctrl) inflight = null;
    }
  }

  return {
    onUserTurn(ctx: TurnContext): void {
      try {
        // A new turn supersedes the previous one: reset the debounce window and abort anything
        // already talking to Chief so the lanes always reflect the latest turn.
        clearTimer();
        abortInflight();
        timer = setTimeout(() => {
          timer = null;
          void fire(ctx);
        }, debounceMs);
      } catch {
        // Scheduling must never throw into the caller (the interview).
      }
    },
    dispose(): void {
      clearTimer();
      abortInflight();
    },
  };
}
