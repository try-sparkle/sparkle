// The mount refusal names WHICH gate fired — bead sparkle-gyvjyt.
//
// Two properties, and the SECOND is the one this module kept failing: copy must be DISCRIMINABLE,
// and every arm must be REACHABLE. Two successive cuts shipped clean distinctness with a dead arm
// (roborev 65163, then 65167) — first the app-owned agent's, then every id's — because `hasAim` and
// `canAcceptInput` NEST rather than vary independently. Copy the founder can never be shown is not
// harmless: it hides which arm is really answering.
//
// So the cases below assert against each other rather than about one string. An "it mentions the
// agent" test passes against the single generic sentence this replaced, which is exactly the vacuity
// that let the original ambiguity survive several rounds of the founder's reports.
import { describe, expect, it } from "vitest";
import { mountRefusalCause, mountRefusalTail, mountRefusalText } from "./mountRefusal";

const ALL = ["no-target", "pane-not-open"] as const;

describe("mountRefusalCause", () => {
  it("gives the app-owned Sparkle agent its own cause", () => {
    expect(mountRefusalCause({ selfAgent: true })).toBe("pane-not-open");
  });

  it("gives every other agent the no-target cause", () => {
    expect(mountRefusalCause({ selfAgent: false })).toBe("no-target");
  });

  it("EVERY cause is reachable — no arm of this union is dead copy", () => {
    // The guard two cuts of this module lacked, and it is meaningful HERE in a way it was not
    // before: the input is now a single boolean, so enumerating it enumerates every reachable
    // state of the real call site rather than hand-built flag triples the callers cannot produce.
    // That equivalence is the point — if this function ever grows an input again, this case stops
    // being evidence and has to be replaced by one driving the real predicates.
    const produced = new Set([true, false].map((selfAgent) => mountRefusalCause({ selfAgent })));
    expect([...produced].sort()).toEqual([...ALL].sort());
  });
});

describe("the two causes never read the same", () => {
  it("gives them distinct copy", () => {
    expect(mountRefusalTail("pane-not-open")).not.toBe(mountRefusalTail("no-target"));
  });

  it("gives each cause the remedy that actually clears IT, and not the other's", () => {
    // These are not interchangeable politenesses. `pane-not-open` is cleared by clicking THAT row —
    // a derived fact, since the row's mount half calls `open(sparkleAgentId)`, which is precisely
    // what moves `livenessOf` off `unknown`. `no-target` names no row, because a closed build agent
    // may have none left to click and unfollowable advice is its own bug.
    expect(mountRefusalTail("pane-not-open")).toMatch(/click the improve sparkle row/i);
    expect(mountRefusalTail("no-target")).not.toMatch(/improve sparkle/i);
  });

  it("never tells anyone to WAIT, because no arm here is cleared by waiting", () => {
    // An earlier cut said "give it a moment, then send again" for a state that turned out to be
    // either unreachable or — via a stale feed snapshot — an agent that had been DELETED, where
    // waiting is the one thing that cannot help. Pinned so the sentence cannot come back without
    // the state that would justify it.
    for (const cause of ALL) expect(mountRefusalTail(cause)).not.toMatch(/moment|wait/i);
  });
});

describe("every refusal still says the send did not happen and the words came back", () => {
  // The one promise the ORIGINAL single sentence made that has to survive being split. Asserted
  // over the whole set so a future third cause cannot quietly drop it.
  for (const cause of ALL) {
    it(`holds for ${cause}`, () => {
      expect(mountRefusalTail(cause)).toMatch(/didn't send that/i);
      expect(mountRefusalTail(cause)).toMatch(/back in the box/i);
    });
  }
});

describe("mountRefusalText", () => {
  it("is the agent's name followed by exactly the tail the thread renders", () => {
    // ONE STRING, TWO SURFACES. A mounted send shows the thread line OR the notice row, never both,
    // so no reader could ever catch these disagreeing — this is the only thing that can.
    for (const cause of ALL) {
      expect(mountRefusalText("Improve Sparkle", cause)).toBe(
        `Improve Sparkle${mountRefusalTail(cause)}`,
      );
    }
  });

  it("starts with the agent's name, so the notice row says who it is about", () => {
    expect(mountRefusalText("Blueprint UI/UX", "no-target")).toMatch(/^Blueprint UI\/UX/);
  });
});
