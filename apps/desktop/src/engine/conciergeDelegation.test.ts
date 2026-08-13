import { describe, expect, it } from "vitest";
import {
  classifyTool,
  DELEGATION_OPS,
  initialState,
  INVESTIGATIVE_BUILTINS,
  MAX_RUNG,
  noteToolCall,
  nudgeText,
  QUEUED_THRESHOLD,
  readOp,
  SERIAL_THRESHOLD,
  type DelegationState,
  type Nudge,
} from "./conciergeDelegation";

const TURN = "turn-1";

/** Drive N investigative calls through the ladder, collecting every nudge that actually fired.
 *
 *  Collecting the DECISIONS rather than reading the counters is the point: a test that asserted
 *  `state.serial === 6` would pass against a build that counts perfectly and never nudges, which is
 *  the entire feature missing. AGENTS.md: assert the side effect, not the precondition. */
function drive(
  n: number,
  opts: { queuedCount?: number; state?: DelegationState; name?: string } = {},
): { state: DelegationState; nudges: Nudge[] } {
  let state = opts.state ?? initialState();
  const nudges: Nudge[] = [];
  for (let i = 0; i < n; i++) {
    const r = noteToolCall(
      state,
      { name: opts.name ?? "Read", input: '{"file_path":"/x"}' },
      { turnId: TURN, queuedCount: opts.queuedCount },
    );
    state = r.state;
    // Unwrapped here so every assertion below reads a Nudge directly. Collecting the union and
    // narrowing at each call site buys nothing and obscures what is being asserted.
    if (r.decision.action === "nudge") nudges.push(r.decision.nudge);
  }
  return { state, nudges };
}

function dispatchCall() {
  return { name: "mcp__sparkle-control__sparkle_research", input: '{"op":"dispatch","args":{}}' };
}

describe("classifyTool", () => {
  it("treats the concierge's read/search built-ins as investigative", () => {
    for (const name of INVESTIGATIVE_BUILTINS) {
      expect(classifyTool({ name })).toBe("investigative");
    }
  });

  it("treats reading a terminal or checking PRs as investigative — the founder's actual complaint", () => {
    // "reading terminals, checking PR status one at a time" is MCP control traffic, not `Read`.
    // If these were classified "other" the ladder would never fire on the reported behavior.
    expect(classifyTool({ name: "mcp__sparkle-control__sparkle_terminal" })).toBe("investigative");
    expect(classifyTool({ name: "mcp__sparkle-control__sparkle_workflow" })).toBe("investigative");
  });

  it("counts a research DISPATCH as delegation", () => {
    expect(classifyTool(dispatchCall())).toBe("delegation");
  });

  it("counts spawning a build agent as delegation", () => {
    expect(
      classifyTool({
        name: "mcp__sparkle-control__sparkle_lifecycle",
        input: '{"op":"spawn_build_agent","args":{}}',
      }),
    ).toBe("delegation");
  });

  it("counts POLLING a dispatched task as investigation, not delegation", () => {
    // sparkle_research is on both sides. `dispatch` delegates; `get`/`list` are the polling the
    // tool's own description warns against. Getting this backwards would let a concierge silence
    // the ladder forever by polling, which is the opposite of the intent.
    expect(classifyTool({ name: "mcp__sparkle-control__sparkle_research", input: '{"op":"get"}' })).toBe(
      "investigative",
    );
    expect(
      classifyTool({ name: "mcp__sparkle-control__sparkle_research", input: '{"op":"list"}' }),
    ).toBe("investigative");
  });

  it("does not let bookkeeping calls inflate the grind count", () => {
    expect(classifyTool({ name: "TodoWrite" })).toBe("other");
    expect(classifyTool({ name: "ToolSearch" })).toBe("other");
    expect(classifyTool({ name: "" })).toBe("other");
  });
});

describe("readOp — truncated payloads", () => {
  it("reads the op from well-formed JSON", () => {
    expect(readOp('{"op":"dispatch","args":{}}')).toBe("dispatch");
  });

  it("still reads the op when Rust truncated the payload mid-object", () => {
    // The live event clamps input to 512 chars, so this is the NORMAL shape of a big call, not an
    // edge case. `op` is serialized before `args`, so it survives.
    const truncated = '{"op":"dispatch","args":{"question":"why is the buil';
    expect(JSON.parse.bind(null, truncated)).toThrow(); // precondition: genuinely invalid JSON
    expect(readOp(truncated)).toBe("dispatch");
  });

  it("returns null when it cannot tell", () => {
    expect(readOp(undefined)).toBeNull();
    expect(readOp("")).toBeNull();
    expect(readOp("not json at all")).toBeNull();
  });

  it("fails CLOSED — an unreadable dispatch payload does not count as delegation", () => {
    // An unreadable payload must never silence the ladder.
    expect(classifyTool({ name: "mcp__sparkle-control__sparkle_research", input: "garbage" })).toBe(
      "investigative",
    );
  });
});

describe("the ladder fires", () => {
  it("dispatches a nudge at the serial threshold when nobody is waiting", () => {
    const { nudges } = drive(SERIAL_THRESHOLD);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatchObject({ rung: 1, escalate: false });
    expect(nudges[0]?.text).toContain("sparkle_research");
  });

  it("stays silent BELOW the threshold", () => {
    expect(drive(SERIAL_THRESHOLD - 1).nudges).toHaveLength(0);
  });

  it("escalates rung by rung, and stops after the last one", () => {
    // Enough calls to blow through every rung several times over.
    const { nudges } = drive(SERIAL_THRESHOLD * (MAX_RUNG + 3));
    expect(nudges).toHaveLength(MAX_RUNG);
    expect(nudges.map((n) => n.rung)).toEqual([1, 2, 3]);
  });

  it("only the last rung escalates to the founder", () => {
    const { nudges } = drive(SERIAL_THRESHOLD * MAX_RUNG);
    expect(nudges.filter((n) => n.escalate)).toHaveLength(1);
    expect(nudges[MAX_RUNG - 1]?.rung).toBe(MAX_RUNG);
    expect(nudges[MAX_RUNG - 1]?.escalate).toBe(true);
  });
});

// THE PAIRED TEST AGENTS.md REQUIRES. One test showing a nudge at 2 is ambiguous — it would pass
// against a build that nudges at 2 unconditionally, ignoring the queue entirely. The pair pins the
// CAUSE: queued -> fires at 2; not queued -> provably does NOT fire at 2, but still does at 6.
describe("queue-aware threshold", () => {
  it("fires early when the founder has messages queued", () => {
    const { nudges } = drive(QUEUED_THRESHOLD, { queuedCount: 3 });
    expect(nudges).toHaveLength(1);
  });

  it("does NOT fire at that count when nothing is queued — but still fires at the normal one", () => {
    expect(drive(QUEUED_THRESHOLD, { queuedCount: 0 }).nudges).toHaveLength(0);
    expect(drive(SERIAL_THRESHOLD, { queuedCount: 0 }).nudges).toHaveLength(1);
  });

  it("treats an absent queue count as nobody waiting", () => {
    expect(drive(QUEUED_THRESHOLD, {}).nudges).toHaveLength(0);
  });
});

describe("delegating resets the ladder", () => {
  it("a dispatch clears the counters so the next grind starts fresh", () => {
    // Climb to one call short of a nudge...
    const climbed = drive(SERIAL_THRESHOLD - 1);
    expect(climbed.nudges).toHaveLength(0);

    // ...delegate...
    const afterDispatch = noteToolCall(climbed.state, dispatchCall(), { turnId: TURN });
    expect(afterDispatch.decision.action).toBe("none");
    expect(afterDispatch.state.serial).toBe(0);
    expect(afterDispatch.state.delegations).toBe(1);

    // ...and the one call that WOULD have tipped it now does nothing. A counter that only ever
    // climbed would fire here.
    const next = drive(1, { state: afterDispatch.state });
    expect(next.nudges).toHaveLength(0);
  });

  it("a dispatch clears the RUNG, not just the count", () => {
    const climbed = drive(SERIAL_THRESHOLD * 2); // reached rung 2
    expect(climbed.state.rung).toBe(2);
    const afterDispatch = noteToolCall(climbed.state, dispatchCall(), { turnId: TURN });
    expect(afterDispatch.state.rung).toBe(0);

    // The next episode must open at rung 1, not resume at 3.
    const { nudges } = drive(SERIAL_THRESHOLD, { state: afterDispatch.state });
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.rung).toBe(1);
  });
});

describe("turn boundaries", () => {
  it("a new turn wipes the episode", () => {
    const climbed = drive(SERIAL_THRESHOLD - 1);
    const nextTurn = noteToolCall(climbed.state, { name: "Read" }, { turnId: "turn-2" });
    // Two innocent turns must not add up to a nudge neither earned.
    expect(nextTurn.decision.action).toBe("none");
    expect(nextTurn.state.serial).toBe(1);
    expect(nextTurn.state.turnId).toBe("turn-2");
  });
});

describe("nudge text", () => {
  it("names the tool the concierge can actually call", () => {
    const t = nudgeText(1, SERIAL_THRESHOLD);
    expect(t).toContain("sparkle_research");
    // The guideline this replaces said "your own Agent tool" — a tool absent from
    // CONCIERGE_ALLOWED_TOOLS. Naming it again would repeat the exact bug that made two rounds of
    // prompting inert.
    expect(t).not.toMatch(/\bAgent tool\b/);
  });

  it("quotes the real count, and gets singular/plural right", () => {
    expect(nudgeText(1, 1)).toContain("1 investigative tool call and");
    expect(nudgeText(1, 7)).toContain("7 investigative tool calls and");
  });

  it("gets blunter as it climbs", () => {
    expect(nudgeText(2, 6)).toContain("STOP READING");
    expect(nudgeText(3, 9)).toContain("founder");
  });

  it("every delegation op the founder approved is honored", () => {
    for (const op of DELEGATION_OPS) {
      const tool = op === "dispatch" ? "sparkle_research" : "sparkle_lifecycle";
      expect(classifyTool({ name: `mcp__sparkle-control__${tool}`, input: `{"op":"${op}"}` })).toBe(
        "delegation",
      );
    }
  });
});

describe("purity", () => {
  it("never mutates the state it was given", () => {
    const state = initialState();
    const snapshot = { ...state };
    noteToolCall(state, { name: "Read" }, { turnId: TURN });
    expect(state).toEqual(snapshot);
  });
});
