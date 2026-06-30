import { describe, it, expect, vi } from "vitest";
import {
  answerAsVoice,
  VOICE_ANSWER_PROMPT,
  type VoiceAnswerDeps,
  type VoiceAnswerArgs,
} from "./voiceAnswer";

const args: VoiceAnswerArgs = {
  pat: "pat",
  chiefProjectId: "proj",
  voiceName: "Architect",
  instructions: "think in systems",
  question: "Is this design sound?",
  conversation: "we are debating routing",
};

function makeDeps(over: Partial<VoiceAnswerDeps> = {}) {
  const ensureSkill = vi.fn().mockResolvedValue("Architect");
  const startChat = vi.fn().mockResolvedValue({ chat_id: "c", message_id: "m" });
  const pollForResponse = vi.fn().mockResolvedValue("Here is the architect's take.");
  const deps: VoiceAnswerDeps = {
    ensureSkill: ensureSkill as unknown as VoiceAnswerDeps["ensureSkill"],
    startChat: startChat as unknown as VoiceAnswerDeps["startChat"],
    pollForResponse: pollForResponse as unknown as VoiceAnswerDeps["pollForResponse"],
    ...over,
  };
  return { deps, ensureSkill, startChat, pollForResponse };
}

describe("answerAsVoice", () => {
  it("ensures the persona skill with category 'persona' and scope 'project' (the fixed path)", async () => {
    const { deps, ensureSkill } = makeDeps();
    await answerAsVoice(deps, args);
    expect(ensureSkill).toHaveBeenCalledWith(
      "pat",
      "proj",
      "Architect",
      "think in systems",
      "persona",
      "project",
    );
  });

  it("starts a project-scoped, fast chat with skills:[voiceName] and the answer prompt", async () => {
    const { deps, startChat } = makeDeps();
    await answerAsVoice(deps, args);

    const call = startChat.mock.calls[0]!;
    expect(call[0]).toBe("pat");
    expect(call[1]).toBe("proj");
    expect(call[2]).toBe(VOICE_ANSWER_PROMPT(args.question, args.conversation));
    expect(call[3]).toEqual({
      intelligence: "fast",
      scope: { project_ids: ["proj"] },
      skills: ["Architect"],
    });
  });

  it("returns the polled answer text", async () => {
    const { deps, pollForResponse } = makeDeps();
    const out = await answerAsVoice(deps, args);
    expect(out).toBe("Here is the architect's take.");
    expect(pollForResponse).toHaveBeenCalledWith("pat", "proj", "c", "m");
  });

  it("ensures the persona BEFORE starting the chat", async () => {
    const order: string[] = [];
    const ensureSkill = vi.fn(async () => {
      order.push("ensure");
      return "Architect";
    });
    const startChat = vi.fn(async () => {
      order.push("chat");
      return { chat_id: "c", message_id: "m" };
    });
    const { deps } = makeDeps({
      ensureSkill: ensureSkill as unknown as VoiceAnswerDeps["ensureSkill"],
      startChat: startChat as unknown as VoiceAnswerDeps["startChat"],
    });
    await answerAsVoice(deps, args);
    expect(order).toEqual(["ensure", "chat"]);
  });

  it("propagates errors (the UI shows them)", async () => {
    const { deps } = makeDeps({
      pollForResponse: vi
        .fn()
        .mockRejectedValue(new Error("Chief took too long")) as unknown as VoiceAnswerDeps["pollForResponse"],
    });
    await expect(answerAsVoice(deps, args)).rejects.toThrow("Chief took too long");
  });
});
