import { describe, expect, it } from "vitest";
import {
  AUTO_ANSWERABLE_TOOLS,
  DENIED_TOOL_PATTERNS,
  isAutoAnswerableTool,
  isDeniedTool,
  mcpAutoAnswerable,
  mcpToolFromPrompt,
} from "./mcpToolPolicy";

// The exact text the founder was stuck on, reproduced from his report. Kept verbatim as the
// canonical fixture: if the picker's wording drifts, THIS is the case that must keep working.
const FOUNDER_PROMPT = `sparkle-control - set_agent_activity(activity: "Mapping the retro loop")

Do you want to proceed?
1. Yes
2. Yes, and don't ask again
3. No`;

const LIFECYCLE_PROMPT = `sparkle-control - sparkle_lifecycle(op: "discard_agent", agentId: "abc")

Do you want to proceed?
1. Yes
2. Yes, and don't ask again
3. No`;

describe("mcpToolFromPrompt", () => {
  it("reads the display form the picker actually renders", () => {
    expect(mcpToolFromPrompt(FOUNDER_PROMPT)).toBe("set_agent_activity");
  });

  it("reads the wire form", () => {
    expect(mcpToolFromPrompt("mcp__sparkle-control__set_agent_goal(...)")).toBe("set_agent_goal");
  });

  // The server segment contains a dash, so anything that split on "-" would return "control" (or
  // "sparkle") and then fail every list lookup — silently degrading to "ask" for a tool that should
  // auto-answer, or worse, missing a deny match. Pinned because the naive parse looks correct.
  it("does not mistake the dash inside the server name for the separator", () => {
    expect(mcpToolFromPrompt("sparkle-orchestrator - spawn_worker(task: 'x')")).toBe("spawn_worker");
  });

  it("returns null when there is no tool name to read", () => {
    expect(mcpToolFromPrompt("Do you want to proceed?\n1. Yes\n2. No")).toBeNull();
    expect(mcpToolFromPrompt("")).toBeNull();
  });
});

describe("the deny list wins over everything", () => {
  // The whole point of the module. `mcp = "always"` is a real user setting, and it must NOT be
  // able to authorise an agent discard. Asserted as the OUTCOME ("ask"), not as list membership,
  // so it stays true however the lists are refactored.
  it("refuses a lifecycle discard even when the user set mcp = always", () => {
    expect(mcpAutoAnswerable(LIFECYCLE_PROMPT, "always")).toBe("ask");
  });

  it.each([
    ["spawn_worker", "sparkle-orchestrator - spawn_worker(task: 'x')"],
    ["spin_down_worker", "sparkle-orchestrator - spin_down_worker(workerId: 'w')"],
    ["sparkle_lifecycle", LIFECYCLE_PROMPT],
    ["sparkle_workflow", "sparkle-control - sparkle_workflow(op: 'run')"],
    ["claim_pr", "sparkle-control - claim_pr(pr: 1)"],
    ["set_config", "sparkle-control - set_config(key: 'x')"],
    ["set_agent_goal_met", "sparkle-control - set_agent_goal_met(met: true)"],
    ["sparkle_terminal", "sparkle-control - sparkle_terminal(op: 'send')"],
  ])("never auto-answers %s", (_name, prompt) => {
    expect(mcpAutoAnswerable(prompt, "always")).toBe("ask");
    expect(mcpAutoAnswerable(prompt, undefined)).toBe("ask");
  });
});

describe("the allow list is closed", () => {
  // This is the founder's actual relief: no rule set at all, and the narration prompt still never
  // reaches him. It is the assertion that fails against current code.
  it("auto-answers the narration prompt with NO mcp rule configured", () => {
    expect(mcpAutoAnswerable(FOUNDER_PROMPT, undefined)).toBe("auto");
  });

  it.each(AUTO_ANSWERABLE_TOOLS)("auto-answers %s", (tool) => {
    expect(mcpAutoAnswerable(`sparkle-control - ${tool}(x: 1)`, undefined)).toBe("auto");
  });

  // An unknown tool must not ride the allow list. It falls through to the ordinary rule, which is
  // the pre-existing behaviour — this module only ever ADDS caution, it never removes a prompt the
  // category rule would have raised.
  it("does not allowlist an unrecognised tool, but still honours an explicit always", () => {
    const prompt = "some-server - frobnicate_thing(x: 1)";
    expect(mcpAutoAnswerable(prompt, undefined)).toBe("ask");
    expect(mcpAutoAnswerable(prompt, "always")).toBe("auto");
  });

  // Not knowing the name is a DIFFERENT reason to stop than knowing it is dangerous, and it must
  // also end at the human — including under `always`, where the temptation is to shrug and proceed.
  it("asks when the tool name cannot be parsed, even under always", () => {
    expect(mcpAutoAnswerable("Do you want to proceed?\n1. Yes\n2. No", "always")).toBe("ask");
  });
});

describe("list integrity", () => {
  it("every allowlisted tool resolves to auto", () => {
    for (const tool of AUTO_ANSWERABLE_TOOLS) {
      expect(isAutoAnswerableTool(tool)).toBe(true);
    }
  });

  // THE COLLISION THAT FORCED THE PRECEDENCE RULE, pinned so nobody "simplifies" it away.
  // `read_console_messages` is read-only and contains the deny substring `message` (there to catch
  // send_message). Deny-wins would have made a read-only inspection tool prompt forever; the exact
  // verified name is the better evidence, so it wins. Asserted on the real tool, not a synthetic
  // one, because this is the case that actually exists.
  it("an exact allowlist hit beats a deny substring", () => {
    expect(isDeniedTool("read_console_messages")).toBe(true);
    expect(mcpAutoAnswerable("chrome - read_console_messages(x: 1)", undefined)).toBe("auto");
  });

  // ...and the precedence must NOT leak to a name that merely contains an allowlisted one. This is
  // the exemption's blast radius, and it is the reason the allow list is matched exactly.
  it("does not extend the exemption to a name that merely contains an allowlisted one", () => {
    expect(isAutoAnswerableTool("set_agent_activity_and_spawn_worker")).toBe(false);
    expect(mcpAutoAnswerable("x - set_agent_activity_and_spawn_worker(a: 1)", "always")).toBe("ask");
  });

  // The exemption is only defensible while the list stays small enough that each entry has really
  // been vetted. A cap makes growth a deliberate act with a failing test attached, rather than a
  // one-line drive-by that turns the allow list into a general bypass.
  it("keeps the allow list small enough to have been vetted entry by entry", () => {
    expect(AUTO_ANSWERABLE_TOOLS.length).toBeLessThanOrEqual(12);
  });

  // The deny list's value is that it over-matches. If someone "tidies" it into exact names, this
  // fails — a tool that does not exist today but obviously should be denied.
  it("catches a destructive tool nobody has written yet", () => {
    expect(isDeniedTool("spawn_replica")).toBe(true);
    expect(isDeniedTool("close_project")).toBe(true);
    expect(isDeniedTool("force_push_branch")).toBe(true);
  });

  it("has a non-trivial deny list", () => {
    expect(DENIED_TOOL_PATTERNS.length).toBeGreaterThan(10);
  });
});

describe("an explicit human choice outranks the built-in allow list", () => {
  // The allow list is a default for people who never opened the setting. `never` means the human
  // opened it and said "ask me" — if the allow list still answered for them, the setting would have
  // no way left to express that, which is a worse bug than an extra prompt.
  it("asks for an allowlisted tool when the rule is 'never'", () => {
    expect(mcpAutoAnswerable(FOUNDER_PROMPT, "never")).toBe("ask");
  });

  // ...and `never` cannot be used to *grant* anything either — a denied tool stays denied.
  it("still refuses a denied tool under 'never'", () => {
    expect(mcpAutoAnswerable(LIFECYCLE_PROMPT, "never")).toBe("ask");
  });
});
