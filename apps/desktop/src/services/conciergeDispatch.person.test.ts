// R3's OUTBOUND MIRROR — a PERSON is never a prompt target (bead sparkle-6baj6s).
//
// Design §8 R3 states the inbound rule: a peer's chat text must never reach an agent's stdin,
// because shipped defaults auto-approve every permission category including bash, so such a path is
// remote code execution on the recipient's Mac delivered by a stranger from the public directory.
// R3's own wording names the reverse — "so a future contributor wiring @mentions cannot do it
// accidentally" — and this file pins that reverse.
//
// WHY THE HAZARD IS REAL RATHER THAN THEORETICAL. `socialStore.roster()` publishes people into the
// mention picker carrying `canAcceptInput: true`. That is CORRECT on its own terms — delivery is
// persist-then-fan-out, so a person can always receive a message and availability is not a routing
// gate — but to the concierge that field means "can receive a PROMPT", and `dispatchConciergeAnswer`
// is documented as the single door into a local PTY. Wiring roster() into the picker without this
// guard hands `@Ada` straight to that door.
//
// ══ BIDIRECTIONAL, DELIBERATELY (AGENTS.md) ═══════════════════════════════════════════════════
// This predicate both BLOCKS and ALLOWS, so one direction of assertion is half a test:
//   • WIDENING (the guard refuses less) must red a test proving the person id is still BLOCKED.
//   • NARROWING (the guard refuses more) must red a test proving a real agent still DELIVERS.
// A file holding only the refusals would be green over a build that refused literally everything,
// which is why the delivering cases below are not padding.
//
// AND EVERY REFUSAL ASSERTS THE SIDE EFFECT, NOT THE VERDICT. A `path` assertion alone is satisfied
// by an implementation that returns the right string AND still writes to the PTY — the exact bug
// this guard exists to prevent — so each refusal pins that neither write primitive was called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionButton } from "./suggestions/types";

vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return {
    writePtyChainedStrict: vi.fn(async () => {}),
    submitPrompt: vi.fn(async () => {}),
    PtyGoneError,
  };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "SCREEN") }));
vi.mock("./suggestions/heuristics", () => ({
  detectTerminalPrompts: vi.fn((): SuggestionButton[] => []),
}));
vi.mock("./terminalViewport", () => ({ getAgentViewport: vi.fn(() => null) }));

import { submitPrompt, writePtyChainedStrict } from "../pty";
import { detectTerminalPrompts } from "./suggestions/heuristics";
import { getAgentViewport } from "./terminalViewport";
import { dispatchConciergeAnswer, wasSubmitted } from "./conciergeDispatch";
import { personAgentId, PERSON_ID_PREFIX } from "../engine/social";

const AGENT = "agent-1";
/** Minted through the real helper, never typed as a literal: if the namespace ever changes, this
 *  test must move with it rather than keep asserting a prefix nothing produces. */
const ADA = personAgentId("soc-ada");

/** A real gesture, so the AUTHORITY gate — which runs first — is never what refuses here. Without
 *  this the file would pass with the person guard deleted, since `unauthorized` is also a refusal
 *  that writes nothing. */
const OPTS = { authority: { kind: "mention", agentId: AGENT } as const, userPrompt: false };

/** The assertion this file is about: not one byte reached a PTY, by either primitive. */
function expectNothingWritten(): void {
  expect(submitPrompt).not.toHaveBeenCalled();
  expect(writePtyChainedStrict).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.mocked(getAgentViewport).mockReturnValue({ text: "$ ", alternateBuffer: false });
  vi.mocked(detectTerminalPrompts).mockReturnValue([]);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("a person is refused at the one door into a PTY", () => {
  it("refuses a person id and writes nothing", async () => {
    const r = await dispatchConciergeAnswer(ADA, "can you look at this?", {
      ...OPTS,
      authority: { kind: "mention", agentId: ADA } as const,
    });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("person-not-promptable");
    expectNothingWritten();
  });

  // The refusal must also be honest to `wasSubmitted`, which is what callers read to decide whether
  // to promise delivery. A refusal reported as submitted is how a caller comes to tell the user
  // their words landed somewhere they never went.
  it("never counts as submitted", async () => {
    const r = await dispatchConciergeAnswer(ADA, "hello", {
      ...OPTS,
      authority: { kind: "mention", agentId: ADA } as const,
    });
    expect(wasSubmitted(r)).toBe(false);
  });

  // ORDERING. The guard sits AHEAD of the emptiness check and every screen read, so a person id is
  // refused for being a PERSON rather than for whatever the screen happens to show. Without this,
  // a reviewer tidying the function could sink the guard below the screen branch and a person on a
  // full-screen agent would come back `alternate-screen` — a refusal whose remedy ("quit the
  // editor") is an instruction that can never succeed, since there is no editor and no agent.
  it("refuses for being a person even when the screen would also refuse", async () => {
    vi.mocked(getAgentViewport).mockReturnValue({ text: "~\n~\n~", alternateBuffer: true });
    const r = await dispatchConciergeAnswer(ADA, "hello", {
      ...OPTS,
      authority: { kind: "mention", agentId: ADA } as const,
    });
    expect(r.path).toBe("person-not-promptable");
    expectNothingWritten();
  });

  // …and ahead of the EMPTY check too, for the same reason: "you sent a blank message" invites a
  // retry with words in it, which would be refused all over again.
  it("refuses a blank body for being a person, not for being blank", async () => {
    const r = await dispatchConciergeAnswer(ADA, "   ", {
      ...OPTS,
      authority: { kind: "mention", agentId: ADA } as const,
    });
    expect(r.path).toBe("person-not-promptable");
    expectNothingWritten();
  });

  // THE BARE PREFIX NAMES NOBODY, and `isPersonAgentId` is false for it — so it must NOT take the
  // person arm. It is not an agent either; it simply is not a person id, and this pins that the
  // guard reads the namespace helper rather than doing its own `startsWith`.
  it("does not treat the bare prefix as a person", async () => {
    const r = await dispatchConciergeAnswer(PERSON_ID_PREFIX, "hello", {
      ...OPTS,
      authority: { kind: "mention", agentId: PERSON_ID_PREFIX } as const,
    });
    expect(r.path).not.toBe("person-not-promptable");
  });
});

// ══ THE OTHER DIRECTION ═══════════════════════════════════════════════════════════════════════
// Narrowing the guard — making it refuse MORE — has to red something, or the file above is
// satisfied by a build that refuses every send in the app.
describe("an ordinary agent still gets its prompt", () => {
  it("delivers free text to a real agent id", async () => {
    const r = await dispatchConciergeAnswer(AGENT, "rebase onto main please", OPTS);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("free-text");
    expect(wasSubmitted(r)).toBe(true);
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "rebase onto main please", expect.anything());
  });

  // A uuid-shaped id containing the WORD person must not be caught: the namespace is a prefix with
  // a colon, and a substring test would refuse a legitimate agent forever with a message about
  // chat. This is the false-positive direction, which costs a user their send.
  it("delivers to an agent whose id merely contains the word", async () => {
    const id = "a-person-shaped-uuid";
    const r = await dispatchConciergeAnswer(id, "go", {
      ...OPTS,
      authority: { kind: "mention", agentId: id } as const,
    });
    expect(r.path).toBe("free-text");
    expect(submitPrompt).toHaveBeenCalledWith(id, "go", expect.anything());
  });
});
