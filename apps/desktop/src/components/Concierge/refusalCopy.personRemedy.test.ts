// THE `person-not-promptable` REMEDY HAS TO BE A THING THE READER CAN ACTUALLY DO
// (sparkle-reviewer probe 2 on PR #3068).
//
// AGENTS.md § User-facing copy is code: *"A refusal or remedy message is an instruction the user
// will follow, so the alternative it suggests must be safe under the SAME conditions that
// triggered the refusal, or the refusal accomplished nothing."* This line used to read *"open your
// chat with Ada and send it there"* — and `Workspace` renders the one production `<ChatPane>` with
// no `useThread`, so that pane runs `useUnwiredChatThread`, whose `send` answers every submission
// with `{ ok: false, reason: "no_transport" }`. The remedy was not merely unhelpful; it was
// impossible, which is the dead-instruction shape that rule exists to stop.
//
// PAIRED, because a negative-only copy ratchet is half a ratchet (AGENTS.md): deleting the remedy
// outright would satisfy the negative while leaving the reader with no exit at all, which is the
// `unauthorized` dead end this arm was split off from in the first place. So the positive demands
// that an exit is still NAMED, and the negative demands it is not the inert pane.
import { describe, expect, it } from "vitest";

import { refusalCopy } from "./refusalCopy";
import type { RefusalVoice } from "./refusalCopy";

const ADA = { id: "person:soc-ada", name: "Ada" };
const VOICES: RefusalVoice[] = ["approval", "prompt"];

/** Both renderings, because `md` and `spoken` are built from the same slots and either can rot. */
const renderings = (voice: RefusalVoice): string[] => {
  const said = refusalCopy("person-not-promptable", ADA, voice);
  return [said.md, said.spoken];
};

describe("the person-not-promptable remedy", () => {
  for (const voice of VOICES) {
    it(`does not send the ${voice} reader to the chat pane, which cannot send`, () => {
      for (const text of renderings(voice)) {
        expect(text, "the chat pane runs useUnwiredChatThread — its send returns no_transport").not.toMatch(
          /open (your|the) chat/i,
        );
      }
    });

    it(`still names an exit for the ${voice} reader, and it is the composer`, () => {
      for (const text of renderings(voice)) {
        // The path this PR built and the only one that delivers: address the person with the sigil
        // in the concierge composer.
        expect(text, "a refusal with no achievable exit is the dead end this arm was split off from").toMatch(
          /@ in the composer/i,
        );
      }
    });

    it(`still says WHY, so the ${voice} reader is not just redirected`, () => {
      for (const text of renderings(voice)) {
        expect(text).toMatch(/is a person, not an agent/i);
      }
    });
  }
});
