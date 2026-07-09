// Expert voices (Phase 3 of the Think revamp): generate a small slate of project-grounded personas
// and register them as Chief skills, so the Think sidebar can surface them and the user can
// @mention them. Pure composition (DI) so the generation logic is unit-testable; the UI passes the
// real Claude (structuredJson) + Chief (ensureSkill) backends.
//
// A persona is a POINT-OF-VIEW LENS, not a knowledge base — `instructions` describe attitude and
// concerns, while the actual project knowledge comes from Chief's library when the voice answers.
// The Skeptic becomes one of these; Chief itself is the always-on librarian, so there is no
// separate "Librarian" voice.

export interface VoiceDef {
  /** Display name + @mention handle, e.g. "Novice Vibe Coder". */
  name: string;
  /** One-sentence "who they are", shown under the name in the sidebar. */
  oneLiner: string;
  /** The persona instructions registered as the Chief skill (the POV lens, not facts). */
  instructions: string;
}

export interface GenerateVoicesDeps {
  structuredJson: <T>(system: string, user: string, maxTokens?: number, purpose?: string) => Promise<T>;
  /** Register (idempotently) a persona skill in Chief; resolves to the skill name. */
  ensureVoice: (name: string, instructions: string) => Promise<string>;
}

export interface GenerateVoicesArgs {
  /** A short summary of the project's Chief library (themes/domains) to ground the slate. */
  corpusSummary: string;
  /** The Think conversation so far, so the voices fit the current discussion. */
  conversation: string;
  /** Max voices to keep (default 5). */
  max?: number;
}

export const VOICES_SYSTEM = [
  "You design a small slate of expert PERSONAS to advise on a software project.",
  "From the project's library summary and the current conversation, propose the most useful expert",
  "voices to consult. Output ONLY a JSON object of this exact shape:",
  '{ "voices": [ { "name": string, "oneLiner": string, "instructions": string } ] }.',
  "Each persona is a POINT-OF-VIEW LENS, not a knowledge base: `instructions` describe who they are,",
  "what they care about, and how they react — NOT project facts (those come from the library at",
  "answer time). `name` is a short handle (e.g. 'Novice Vibe Coder'); `oneLiner` is one sentence.",
  "Propose between 3 and 5 voices. Output ONLY the JSON — no prose, no code fences.",
].join(" ");

/**
 * Generate a slate of expert-voice personas grounded in the project library + conversation, and
 * register each as a Chief persona skill. Returns the kept slate (well-formed, capped). Errors
 * propagate so the UI surfaces a clean failure rather than a half-registered set.
 */
export async function generateVoices(
  deps: GenerateVoicesDeps,
  args: GenerateVoicesArgs,
): Promise<VoiceDef[]> {
  const plan = await deps.structuredJson<{ voices: VoiceDef[] }>(
    VOICES_SYSTEM,
    `Project library summary:\n${args.corpusSummary}\n\nConversation so far:\n${args.conversation}`,
    undefined,
    "Generating expert voices",
  );
  const voices = (plan?.voices ?? [])
    // Drop malformed entries — a voice with no name or no instructions can't be @mentioned or run.
    .filter((v) => v?.name?.trim() && v?.instructions?.trim())
    .slice(0, args.max ?? 5);
  for (const v of voices) {
    await deps.ensureVoice(v.name, v.instructions);
  }
  return voices;
}
