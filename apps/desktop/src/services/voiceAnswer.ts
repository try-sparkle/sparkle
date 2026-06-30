// voiceAnswer — answering as a specific expert voice in the redesigned Think tab.
//
// When the user `@<expert-voice> …` mentions a voice, that voice (a Chief persona skill) answers
// and Claude Code stays silent. This is the foreground, user-initiated lane: ensure the persona
// skill exists (project-scoped — the path the `createSkill` scope fix unblocked), then run ONE
// project-scoped Chief chat with the persona applied (`skills: [voiceName]`) so the answer carries
// the voice's point of view while drawing facts from the project library. Mirrors the Skeptic lane
// in `librarian.ts`.
//
// Pure composition (DI) so it's unit-testable; the UI injects the real ensureSkill / startChat /
// pollForResponse backends. Unlike `chiefParticipant`, errors propagate — the UI shows them, since
// the user explicitly asked this voice a question.
import type { ChatOptions, ChiefScope } from "./chief";

export interface VoiceAnswerDeps {
  ensureSkill: typeof import("./chief").ensureSkill;
  startChat: typeof import("./chief").startChat;
  pollForResponse: typeof import("./chief").pollForResponse;
}

export interface VoiceAnswerArgs {
  pat: string;
  chiefProjectId: string;
  /** The persona's name — used both as the ensured skill name and the `skills:[…]` reference. */
  voiceName: string;
  /** The persona instructions (the POV lens) registered as the Chief persona skill. */
  instructions: string;
  /** The user's question for this voice. */
  question: string;
  /** The conversation so far, passed as brief context for the answer. */
  conversation: string;
}

/** Prompt the voice answers: in-character, grounded in the project library, clean GFM markdown. */
export function VOICE_ANSWER_PROMPT(question: string, conversation: string): string {
  return [
    "Answer the user's question in character, applying your persona's point of view, and ground",
    "your answer in THIS project's library where relevant. Respond in clean GitHub-flavored",
    "markdown. Be concrete and useful; skip any preamble about who you are.",
    "",
    "Conversation so far (for context):",
    conversation,
    "",
    "User's question:",
    question,
  ].join("\n");
}

/**
 * Answer the user's question as `voiceName`. Ensures the persona skill (category "persona", scope
 * "project" — the fixed `createSkill` path), then starts a project-scoped Chief chat with the
 * persona applied and polls for the answer. Returns the answer text. Errors propagate so the UI
 * can surface a clean failure.
 */
export async function answerAsVoice(deps: VoiceAnswerDeps, args: VoiceAnswerArgs): Promise<string> {
  // Ensure the persona, pinned to the project scope. Passing scope explicitly exercises the fixed
  // path: an unset scope used to trip `publicapi.skills.create`'s `scope.invalid` and break voices.
  await deps.ensureSkill(
    args.pat,
    args.chiefProjectId,
    args.voiceName,
    args.instructions,
    "persona",
    "project",
  );

  // Project-scoped chat with the persona applied — mirrors the Skeptic lane's options shape so the
  // voice's POV is layered over facts retrieved from the project library.
  const scope: ChiefScope = { project_ids: [args.chiefProjectId] };
  const opts: ChatOptions = { intelligence: "fast", scope, skills: [args.voiceName] };
  const { chat_id, message_id } = await deps.startChat(
    args.pat,
    args.chiefProjectId,
    VOICE_ANSWER_PROMPT(args.question, args.conversation),
    opts,
  );
  return deps.pollForResponse(args.pat, args.chiefProjectId, chat_id, message_id);
}
