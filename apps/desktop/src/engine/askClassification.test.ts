// THE CLASSIFY STEP — bead `sparkle-o05vcs.2`.
//
// WHAT THESE TESTS ARE CAREFUL NOT TO BE. "`ASK_RULES` has three entries" is the vacuous shape here:
// it asserts a declaration, not a behaviour, and would pass against a build whose predicates all
// returned null. Every test below drives `classifyAsk` and asserts the VERDICT and the RULE ID it
// names — the two things that actually get written on a bead.
import { describe, it, expect } from "vitest";
import {
  ASK_CLASSIFICATION_MARKER,
  ASK_RULES,
  PIECE_THRESHOLD,
  askRuleById,
  classifyAsk,
  formatAskClassificationComment,
  listPieces,
  seriesPieces,
  surfacesNamed,
} from "./askClassification";

describe("classifyAsk — the founder's written rule", () => {
  it("calls a one-finish-line ask a task, by the default rule", () => {
    const c = classifyAsk({
      title: "Fix the retry backoff jitter",
      body: "The reconnect loop retries with a fixed delay. Make it jittered.",
    });
    expect(c.verdict).toBe("task");
    expect(c.ruleId).toBe("task-one-finish-line");
  });

  it("calls an ask that lists 3+ independently-completable pieces an epic", () => {
    const c = classifyAsk({
      title: "Reconnect handling",
      body: [
        "- add jitter to the retry delay",
        "- surface the attempt count in the status line",
        "- write the failure to the session log",
      ].join("\n"),
    });
    expect(c.verdict).toBe("epic");
    expect(c.ruleId).toBe("epic-three-plus-pieces");
    // The EVIDENCE is the half that makes a wrong call arguable — it must name the pieces, not
    // merely count them.
    expect(c.evidence).toHaveLength(3);
    expect(c.evidence[0]).toContain("jitter");
  });

  it("does NOT fire the piece rule at two pieces — the threshold is the founder's number", () => {
    const c = classifyAsk({
      title: "Reconnect handling",
      body: ["- add jitter to the retry delay", "- surface the attempt count"].join("\n"),
    });
    expect(PIECE_THRESHOLD).toBe(3);
    expect(c.verdict).toBe("task");
    expect(c.ruleId).toBe("task-one-finish-line");
  });

  it("counts a written-out series in the TITLE as pieces", () => {
    const c = classifyAsk({
      title: "Wire the relay, add the retry, and log the failure",
      body: "",
    });
    expect(c.verdict).toBe("epic");
    expect(c.ruleId).toBe("epic-three-plus-pieces");
  });

  it("calls an ask spanning more than one surface an epic, even with nothing enumerated", () => {
    const c = classifyAsk({
      title: "Show the agent's model in the sidebar",
      body: "The Rust side already knows it; the React component has to render it.",
    });
    expect(c.verdict).toBe("epic");
    expect(c.ruleId).toBe("epic-multiple-surfaces");
    expect(c.evidence).toContain("Rust core");
    expect(c.evidence).toContain("desktop UI");
  });

  it("does NOT fire the surface rule on a single surface", () => {
    const c = classifyAsk({
      title: "Render the attempt count in the sidebar component",
      body: "One React component, one string.",
    });
    expect(c.verdict).toBe("task");
    expect(c.ruleId).toBe("task-one-finish-line");
  });

  it("prefers the piece rule over the surface rule when both would fire", () => {
    // PRECEDENCE IS PART OF THE CONTRACT — the founder stated the piece clause first, and a bead
    // whose recorded rule flips depending on evaluation order is exactly the mysterious call this
    // module exists to replace.
    const c = classifyAsk({
      title: "Model badge",
      body: ["- add the Rust command", "- render the React component", "- document it in the readme"].join("\n"),
    });
    expect(c.verdict).toBe("epic");
    expect(c.ruleId).toBe("epic-three-plus-pieces");
  });

  it("still names a rule for a blank ask rather than leaving it unclassified", () => {
    const c = classifyAsk({ title: "", body: null });
    expect(c.ruleId).toBe("task-one-finish-line");
    expect(c.verdict).toBe("task");
  });

  it("is deterministic — the same ask always names the same rule", () => {
    const ask = { title: "Wire the relay, add the retry, and log the failure", body: "" };
    expect(classifyAsk(ask)).toEqual(classifyAsk(ask));
  });
});

describe("the counters the rules are built on", () => {
  it("reads bullets and numbered lines as pieces", () => {
    expect(listPieces("- one\n2. two\n* three\nprose line\n- xx")).toEqual(["one", "two", "three"]);
  });

  it("does NOT read ordinary prose commas in a body as pieces", () => {
    // The reason `seriesPieces` is title-only: this sentence is one thought, not three deliverables.
    const prose = "The gate is adversarial in one direction, none is first-class, and the reason is recorded.";
    expect(classifyAsk({ title: "Epic gate", body: prose }).ruleId).toBe("task-one-finish-line");
  });

  it("needs a coordinating word before it splits a title into a series", () => {
    expect(seriesPieces("Fix the retry, which is flaky, in the reconnect loop")).toEqual([]);
  });

  it("names surfaces in a stable order", () => {
    expect(surfacesNamed("A React component and a Rust command")).toEqual(["desktop UI", "Rust core"]);
  });
});

describe("recording the call", () => {
  it("writes the marker, the verdict, the rule id and the evidence into one greppable line", () => {
    const line = formatAskClassificationComment(
      classifyAsk({ title: "Reconnect", body: "- add jitter\n- show attempts\n- log failures" }),
    );
    expect(line.startsWith(`${ASK_CLASSIFICATION_MARKER}: epic`)).toBe(true);
    expect(line).toContain("epic-three-plus-pieces");
    expect(line).toContain("Fired on:");
  });

  it("recovers a rule's sentence from the id recorded on a bead", () => {
    for (const rule of ASK_RULES) {
      expect(askRuleById(rule.id)?.statement).toBe(rule.statement);
    }
    expect(askRuleById("epic-retired-rule")).toBeNull();
  });
});
