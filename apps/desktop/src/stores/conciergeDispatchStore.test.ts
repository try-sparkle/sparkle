// THE DELEGATION ROSTER FOLD-IN (bead: concierge dispatch memory).
//
// The load-bearing assertion in every test here is the SIDE EFFECT: the delegation's own words end
// up in the string the turn will carry. Asserting that the ledger holds a row, or that the builder
// returned something non-empty, would prove nothing — the measured failure was a concierge that had
// a live delegation and still answered as if the work had never been dispatched, and the only thing
// that fixes it is the delegation being IN THE PROMPT.
import { describe, expect, it } from "vitest";
import {
  buildDispatchPreamble,
  dispatchPreambleNow,
  DISPATCH_FETCH_LIMIT,
  DISPATCH_PREAMBLE_HEADER,
  humanAge,
  MAX_ASK_CHARS,
  MAX_DISPATCH_LINES,
  withDispatchPreamble,
} from "./conciergeDispatchStore";
import type { RecalledDispatch } from "../services/dispatchRecall";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function dispatch(over: Partial<RecalledDispatch> = {}): RecalledDispatch {
  const dispatchedAtMs = over.dispatchedAtMs ?? NOW - 5 * MIN;
  return {
    targetId: "agent-1",
    channel: "build",
    name: "Preview Card Inline",
    nameAtDispatch: "Preview Card Inline",
    renamedSince: false,
    projectId: "p1",
    projectName: "sparkle",
    dispatchedAtMs,
    ageMs: NOW - dispatchedAtMs,
    ask: "make the preview cards inline in chat",
    brief: "Investigate rendering preview cards inline at one-third width.",
    briefTruncated: false,
    beads: [],
    mode: "build",
    by: "concierge",
    status: "working",
    addressable: true,
    ...over,
  };
}

describe("buildDispatchPreamble — an open delegation reaches the prompt", () => {
  it("puts the agent's LIVE NAME, the ask, the age, the status and the id on one line", () => {
    const out = buildDispatchPreamble([dispatch({ targetId: "8f590b78", ask: "preview cards inline" })], NOW);
    expect(out).toContain(DISPATCH_PREAMBLE_HEADER);
    expect(out).toContain("Preview Card Inline");
    expect(out).toContain("preview cards inline");
    expect(out).toContain("5m ago");
    expect(out).toContain("working");
    expect(out).toContain("8f590b78");
  });

  it("ends the line WITH THE ID — the handle 'go check on that agent' needs, where a handle belongs", () => {
    const out = buildDispatchPreamble([dispatch({ targetId: "8f590b78" })], NOW);
    const line = out.split("\n").find((l) => l.includes("8f590b78"));
    expect(line).toBeDefined();
    // Not merely "present somewhere": LAST. A line that trailed off into the brief would bury it.
    expect(line!.trimEnd().endsWith("8f590b78")).toBe(true);
  });

  it("leads with the LIVE name and notes the dispatch-time one when the agent was renamed", () => {
    const out = buildDispatchPreamble(
      [dispatch({ name: "Preview Card Inline", nameAtDispatch: "Build 17", renamedSince: true })],
      NOW,
    );
    // What he can SEE on screen comes first — "Build 17 is not the name of the agent right now …
    // that doesn't mean anything to me because I can't see it."
    expect(out.indexOf("Preview Card Inline")).toBeLessThan(out.indexOf("Build 17"));
    // ...and the old name is still reported, so a rename is visible rather than silently papered over.
    expect(out).toContain("Build 17");
  });

  it("does NOT mention a dispatch-time name when nothing was renamed", () => {
    const out = buildDispatchPreamble([dispatch({ name: "Steady", nameAtDispatch: "Steady" })], NOW);
    expect(out).not.toContain("dispatched as");
  });

  it("marks a target that cannot be messaged, so the concierge never offers a channel that does not exist", () => {
    const out = buildDispatchPreamble(
      [dispatch({ channel: "research", targetId: "r-77", addressable: false, status: "unknown" })],
      NOW,
    );
    expect(out).toContain("no inbox");
    // The id is STILL last — the marker sits before it, never in the handle's place.
    const line = out.split("\n").find((l) => l.includes("r-77"))!;
    expect(line.trimEnd().endsWith("r-77")).toBe(true);
  });

  it("adds NO such marker in the common case — a note on every line is noise", () => {
    expect(buildDispatchPreamble([dispatch({ addressable: true })], NOW)).not.toContain("no inbox");
  });
});

describe("ordering — RECENCY, never alphabetical", () => {
  // THE ASSERTION THAT PINS THE RULE. Three delegations whose recency order is the exact OPPOSITE of
  // their alphabetical order, so a sort creeping in — the bug the sibling memory store actually has,
  // where an alphabetical cut hides 40% of the founder's facts — flips this red. A two-item fixture
  // would pass by luck half the time.
  const alpha = dispatch({ targetId: "a-id", name: "Alpha", ask: "alpha work", dispatchedAtMs: NOW - 300 * MIN });
  const mid = dispatch({ targetId: "m-id", name: "Mike", ask: "mike work", dispatchedAtMs: NOW - 200 * MIN });
  const zulu = dispatch({ targetId: "z-id", name: "Zulu", ask: "zulu work", dispatchedAtMs: NOW - 8 * MIN });

  it("renders newest first, preserving the order openDispatches hands over", () => {
    const out = buildDispatchPreamble([zulu, mid, alpha], NOW);
    expect(out.indexOf("Zulu")).toBeLessThan(out.indexOf("Mike"));
    expect(out.indexOf("Mike")).toBeLessThan(out.indexOf("Alpha"));
  });

  it("keeps the NEWEST when the list is clipped — the eight-minute-old one must never fall off", () => {
    // Newest-first, and one more than fits. Alphabetically "Zulu" sorts last and would be the first
    // thing an alphabetical cap threw away; it is the one that must survive.
    const older = Array.from({ length: MAX_DISPATCH_LINES }, (_v, i) =>
      dispatch({
        targetId: `old-${i}`,
        name: `Alpha ${i}`,
        ask: `older work ${i}`,
        dispatchedAtMs: NOW - (100 + i) * MIN,
      }),
    );
    const out = buildDispatchPreamble([zulu, ...older], NOW);
    expect(out).toContain("zulu work");
    expect(out).toContain("8m ago");
  });
});

describe("truncation — a clipped roster must never read as a complete one", () => {
  it("renders at most MAX_DISPATCH_LINES and SAYS how many more are open", () => {
    const many = Array.from({ length: MAX_DISPATCH_LINES + 3 }, (_v, i) =>
      dispatch({ targetId: `id-${i}`, name: `Agent ${i}`, ask: `subject ${i}`, dispatchedAtMs: NOW - i * MIN }),
    );
    const out = buildDispatchPreamble(many, NOW);
    const rendered = out.split("\n").filter((l) => l.startsWith("- "));
    expect(rendered).toHaveLength(MAX_DISPATCH_LINES);
    // "we have nothing else running" is precisely the false statement this feature exists to
    // prevent, so the overflow is stated rather than left to be inferred from a short list.
    expect(out).toContain("and 3 more open delegation(s) not shown");
    expect(out).toContain(`${MAX_DISPATCH_LINES + 3} open`);
  });

  it("adds NO overflow note when everything is shown", () => {
    const out = buildDispatchPreamble([dispatch(), dispatch({ targetId: "b" })], NOW);
    expect(out).not.toContain("more open delegation(s) not shown");
  });

  it("clips a long ask to one line and marks the clip", () => {
    const huge = "x".repeat(MAX_ASK_CHARS * 4);
    const out = buildDispatchPreamble([dispatch({ ask: `${huge}\nsecond line` })], NOW);
    expect(out).not.toContain(huge);
    expect(out).toContain("…");
    // One delegation is still ONE line — a newline in the ask would split the entry in two.
    expect(out.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });
});

describe("the empty case is a real answer, spelt \"\"", () => {
  it("returns EXACTLY the empty string when nothing is open", () => {
    expect(buildDispatchPreamble([], NOW)).toBe("");
  });

  it("withDispatchPreamble is IDENTITY on the empty preamble — no blank header on every turn", () => {
    const prompt = "what should I do next?";
    expect(withDispatchPreamble("", prompt)).toBe(prompt);
  });

  it("puts a non-empty preamble AHEAD of the prompt", () => {
    const out = withDispatchPreamble("ROSTER", "the founder's message");
    expect(out.startsWith("ROSTER")).toBe(true);
    expect(out).toContain("the founder's message");
  });
});

describe("humanAge — order of magnitude, in the units a human thinks in", () => {
  it("reads in minutes, hours and days", () => {
    expect(humanAge(30_000)).toBe("just now");
    expect(humanAge(8 * MIN)).toBe("8m ago");
    expect(humanAge(3 * 60 * MIN)).toBe("3h ago");
    expect(humanAge(2 * 24 * 60 * MIN)).toBe("2d ago");
  });
});

describe("dispatchPreambleNow — the live read", () => {
  it("renders whatever the ledger hands back, over-fetching so the overflow count is honest", async () => {
    let askedFor = 0;
    const out = await dispatchPreambleNow(
      async (limit) => {
        askedFor = limit;
        return [dispatch({ targetId: "8f590b78", ask: "preview cards inline" })];
      },
      () => NOW,
    );
    expect(out).toContain("preview cards inline");
    expect(out).toContain("8f590b78");
    // Fetching only what we render would make every truncation report "0 more" — i.e. read as a
    // complete list, which is the one thing the disclosure exists to stop.
    expect(askedFor).toBe(DISPATCH_FETCH_LIMIT);
    expect(askedFor).toBeGreaterThan(MAX_DISPATCH_LINES);
  });

  it("degrades to NO SECTION rather than failing the turn when the ledger cannot be read", async () => {
    const out = await dispatchPreambleNow(async () => {
      throw new Error("history.db is locked");
    }, () => NOW);
    expect(out).toBe("");
  });
});
