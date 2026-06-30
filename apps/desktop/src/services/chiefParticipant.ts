// chiefParticipant — "Chief participates in the conversation."
//
// While the user talks to Claude Code in the redesigned Think tab, Chief "pops in" as a distinct
// participant: grounded in ALL of the project's markdown docs (the PRD library), it offers ONE
// short, high-signal observation/opinion/background note when — and only when — it adds genuine
// value, and otherwise stays silent. This is the background, best-effort lane that replaces the
// old Grounding/Challenges rails: a single project-scoped Chief query per (plain) turn that the UI
// renders as a Chief-authored message if it returns something substantive.
//
// Pure composition (DI) like `librarian.ts` / `voices.ts`, so tests drive it with fakes and never
// touch real Chief. The caller injects the real `startChat` + `pollForResponse` backends.
import type { ChatOptions, ChiefScope } from "./chief";

export interface ChiefParticipantDeps {
  startChat: typeof import("./chief").startChat;
  pollForResponse: typeof import("./chief").pollForResponse;
}

export interface ChiefInterjectArgs {
  pat: string;
  chiefProjectId: string;
  /** The running transcript Chief reasons over (already formatted by the caller). */
  conversation: string;
}

// The explicit "I have nothing worth adding" reply. The persona prompt tells Chief to return this
// token verbatim when it would otherwise pad; `chiefInterject` maps it (and an empty reply) to null
// so the UI never renders an empty/filler Chief message.
export const CHIEF_NOTHING_TO_ADD = "__CHIEF_NOTHING_TO_ADD__";

/** Persona prompt: Chief as an opinionated participant grounded in the project library, gated to
 *  interject only when it adds value, else emit the nothing-to-add sentinel. */
export function CHIEF_INTERJECT_PROMPT(conversation: string): string {
  return [
    "You are Chief, a participant in this product-planning conversation, grounded in THIS",
    "project's library of PRD and design docs. You are NOT the main responder — you only chime in",
    "when you genuinely have something worth adding: a relevant prior decision, useful background",
    "or color, a sharp observation, or an opinion the participants would value. Offer at most ONE",
    "short, high-signal note (1-3 sentences; markdown ok). Do NOT summarize the conversation, do",
    "NOT restate what was already said, and do NOT pad. If you have nothing that adds genuine",
    `value, reply with EXACTLY "${CHIEF_NOTHING_TO_ADD}" and nothing else.`,
    "",
    "Conversation so far:",
    conversation,
  ].join("\n");
}

// Normalize a reply for sentinel comparison: strip surrounding whitespace/quotes/backticks/periods
// and uppercase, so a model that lightly wraps or decorates the sentinel still reads as "nothing to
// add" rather than slipping through as a (junk) observation.
function normalizeSentinel(text: string): string {
  return text.replace(/[\s"'`.]+/g, "").toUpperCase();
}

function isNothingToAdd(text: string): boolean {
  return normalizeSentinel(text) === normalizeSentinel(CHIEF_NOTHING_TO_ADD);
}

/**
 * Fire ONE project-scoped Chief query (fast intelligence) for a possible interjection grounded in
 * the project's PRD library. Returns the trimmed observation, or `null` when Chief has nothing
 * worth adding (an empty or sentinel reply). Best-effort: this is a background lane that must never
 * break the conversation, so an ordinary empty result — including a timeout or transport error —
 * resolves to `null` rather than throwing.
 */
export async function chiefInterject(
  deps: ChiefParticipantDeps,
  args: ChiefInterjectArgs,
): Promise<string | null> {
  try {
    const scope: ChiefScope = { project_ids: [args.chiefProjectId] };
    const opts: ChatOptions = { intelligence: "fast", scope };
    const { chat_id, message_id } = await deps.startChat(
      args.pat,
      args.chiefProjectId,
      CHIEF_INTERJECT_PROMPT(args.conversation),
      opts,
    );
    const reply = await deps.pollForResponse(args.pat, args.chiefProjectId, chat_id, message_id);
    const trimmed = (reply ?? "").trim();
    if (!trimmed || isNothingToAdd(trimmed)) return null;
    return trimmed;
  } catch {
    // A background interjection is advisory only — swallow everything and degrade to "nothing to
    // add" so a flaky Chief turn can't surface as an error in the conversation.
    return null;
  }
}
