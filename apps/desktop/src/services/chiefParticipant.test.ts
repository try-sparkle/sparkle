import { describe, it, expect, vi } from "vitest";
import {
  chiefInterject,
  CHIEF_INTERJECT_PROMPT,
  CHIEF_NOTHING_TO_ADD,
  type ChiefParticipantDeps,
} from "./chiefParticipant";

const args = { pat: "pat", chiefProjectId: "proj", conversation: "we are debating routing" };

function makeDeps(reply: string, over: Partial<ChiefParticipantDeps> = {}) {
  const startChat = vi.fn().mockResolvedValue({ chat_id: "c", message_id: "m" });
  const pollForResponse = vi.fn().mockResolvedValue(reply);
  const deps: ChiefParticipantDeps = {
    startChat: startChat as unknown as ChiefParticipantDeps["startChat"],
    pollForResponse: pollForResponse as unknown as ChiefParticipantDeps["pollForResponse"],
    ...over,
  };
  return { deps, startChat, pollForResponse };
}

describe("chiefInterject", () => {
  it("returns the trimmed observation for a substantive reply", async () => {
    const { deps } = makeDeps("  This collides with the v0.5 routing decision.  ");
    const out = await chiefInterject(deps, args);
    expect(out).toBe("This collides with the v0.5 routing decision.");
  });

  it("fires ONE project-scoped, fast-intelligence chat carrying the persona prompt", async () => {
    const { deps, startChat, pollForResponse } = makeDeps("an observation");
    await chiefInterject(deps, args);

    expect(startChat).toHaveBeenCalledTimes(1);
    const call = startChat.mock.calls[0]!;
    expect(call[0]).toBe("pat");
    expect(call[1]).toBe("proj");
    expect(call[2]).toBe(CHIEF_INTERJECT_PROMPT(args.conversation));
    expect(call[3]).toEqual({
      intelligence: "fast",
      scope: { project_ids: ["proj"] },
    });
    // Polls the chat/message ids returned by startChat.
    expect(pollForResponse).toHaveBeenCalledWith("pat", "proj", "c", "m");
  });

  it("returns null on the explicit nothing-to-add sentinel (even lightly wrapped)", async () => {
    for (const reply of [CHIEF_NOTHING_TO_ADD, `"${CHIEF_NOTHING_TO_ADD}"`, ` ${CHIEF_NOTHING_TO_ADD}\n`]) {
      const { deps } = makeDeps(reply);
      expect(await chiefInterject(deps, args)).toBeNull();
    }
  });

  it("returns null on an empty / whitespace reply", async () => {
    expect(await chiefInterject(makeDeps("").deps, args)).toBeNull();
    expect(await chiefInterject(makeDeps("   \n  ").deps, args)).toBeNull();
  });

  it("never throws — a failing Chief turn degrades to null", async () => {
    const startChat = vi.fn().mockRejectedValue(new Error("boom"));
    const pollForResponse = vi.fn();
    const deps = {
      startChat: startChat as unknown as ChiefParticipantDeps["startChat"],
      pollForResponse: pollForResponse as unknown as ChiefParticipantDeps["pollForResponse"],
    };
    await expect(chiefInterject(deps, args)).resolves.toBeNull();
  });
});
