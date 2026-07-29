// The phrasing half of the thinking indicator. Pure — no DOM, no store, no Tauri.
//
// The property under test throughout is HONESTY, not prettiness: the line must say something that
// was actually observed, in the tense the observation supports, and must decline rather than invent
// when it has nothing it can vouch for.
import { describe, expect, it } from "vitest";

import {
  conciergeActivityLine,
  conciergeActivitySubject,
  type ConciergeToolActivity,
} from "./conciergeActivityLine";

function activity(over: Partial<ConciergeToolActivity> = {}): ConciergeToolActivity {
  return {
    domain: "terminal",
    op: "read_agent_terminal",
    subject: "Kraken Auth",
    outcome: "running" as const,
    seq: 1,
    ...over,
  };
}

describe("conciergeActivityLine", () => {
  it("names the tool and its subject while the call is in flight", () => {
    const line = conciergeActivityLine(activity());
    expect(line).toEqual({ icon: "terminal", text: "Reading Kraken Auth's terminal" });
  });

  // The tense is the difference between "is doing" and "did", and the column shows both. A single
  // present-tense phrase would keep claiming a finished call was still running.
  it("switches to the past tense once the call has settled", () => {
    expect(conciergeActivityLine(activity({ outcome: "done" }))?.text).toBe(
      "Read Kraken Auth's terminal",
    );
  });

  // THE REFUSAL CASE, and why it is not the past tense. `dispatchConciergeTool` is total, so a policy
  // denial and an ask-tier tool the human has not approved come back as ordinary replies — and a
  // past tense there is a plain falsehood. The ask tier makes it vivid: the same 360px column would
  // read "Merged PR #753" directly above the approval request for the merge it is still waiting on.
  it("reports a refused call as an attempt, never as something that happened", () => {
    const refused = (over: Partial<ConciergeToolActivity>) =>
      conciergeActivityLine(activity({ outcome: "refused", ...over }))?.text;
    expect(refused({ domain: "workflow", op: "merge_pr", subject: "PR #753" })).toBe(
      "Tried merging PR #753",
    );
    expect(refused({ domain: "lifecycle", op: "discard_agent" })).toBe(
      "Tried discarding Kraken Auth",
    );
    expect(refused({ domain: "workspace", op: "quit_app" })).toBe("Tried quitting Sparkle");
    expect(refused({})).toBe("Tried reading Kraken Auth's terminal");
  });

  // The attempt frame is built by lowering the present phrase's first letter, so every op in every
  // table has to survive it — no proper nouns in first position, no second table to forget.
  it("keeps the attempt frame grammatical for a subjectless op", () => {
    expect(
      conciergeActivityLine(
        activity({ domain: "workspace", op: "list_projects", outcome: "refused" }),
      )?.text,
    ).toBe("Tried looking over your projects");
  });

  // An agent the concierge just closed is gone from the store by the time its own reply lands, so an
  // unresolvable subject is a NORMAL outcome. The indefinite phrasing is the honest rendering —
  // never a stale name, and never the raw id, which means nothing to a human.
  it("degrades to an indefinite subject rather than a guess or an id", () => {
    expect(conciergeActivityLine(activity({ subject: null }))?.text).toBe(
      "Reading an agent's terminal",
    );
    expect(
      conciergeActivityLine(activity({ domain: "workflow", op: "merge_pr", subject: null }))?.text,
    ).toBe("Merging the PR");
  });

  it("carries each domain's own glyph family", () => {
    const icon = (domain: string, op: string) =>
      conciergeActivityLine(activity({ domain, op }))?.icon;
    expect(icon("lifecycle", "close_agent")).toBe("agents");
    expect(icon("terminal", "get_agent_status")).toBe("terminal");
    expect(icon("workflow", "merge_pr")).toBe("workflow");
    expect(icon("workspace", "list_projects")).toBe("workspace");
    expect(icon("diff", "list_changed_files")).toBe("workflow");
  });

  // The diff domain's phrases were shipped un-exercised: DIFF_PHRASES was typed
  // `Record<string, …>` rather than over its op union, so a fourth op would have fallen through to
  // the un-phrased "Using diff · …" default with tsc still green (roborev 55193). The type is fixed;
  // this covers the rendering.
  it("phrases a diff op with the agent it is about", () => {
    expect(
      conciergeActivityLine(
        activity({ domain: "diff", op: "list_changed_files", subject: "Kraken Auth" }),
      )?.text,
    ).toBe("Looking at what Kraken Auth changed");
  });

  it("falls back to the indefinite form when the agent could not be named", () => {
    expect(
      conciergeActivityLine(activity({ domain: "diff", op: "list_commits", subject: null }))?.text,
    ).toBe("Reading an agent's commits");
  });

  it("phrases a PR op with the number the call carried", () => {
    const line = conciergeActivityLine(
      activity({ domain: "workflow", op: "pr_checks_status", subject: "PR #753" }),
    );
    expect(line?.text).toBe("Checking PR #753's checks");
  });

  // A subjectless op must not leave a dangling possessive or a stray space.
  it("leaves a subjectless op's phrase alone", () => {
    expect(
      conciergeActivityLine(activity({ domain: "workspace", op: "list_projects", subject: "x" }))
        ?.text,
    ).toBe("Looking over your projects");
  });

  // The DECLINE cases. A wrong sentence is worse than three dots, so anything this module cannot
  // vouch for returns null and the indicator falls back to the bare pulse.
  it("declines an unknown domain rather than inventing a sentence", () => {
    expect(conciergeActivityLine(activity({ domain: "filesystem", op: "rm_rf" }))).toBeNull();
    expect(conciergeActivityLine(activity({ domain: "", op: "" }))).toBeNull();
  });

  // A new tool added to a domain is a FACT even before someone writes it a sentence, so it shows its
  // own name verbatim. Deliberately un-polished: informative now, visibly in need of a phrase.
  it("shows an unknown op inside a known domain by name, unembellished", () => {
    const line = conciergeActivityLine(activity({ domain: "terminal", op: "read_agent_screen" }));
    expect(line).toEqual({ icon: "terminal", text: "Using terminal · read_agent_screen" });
  });

  // …and that branch takes the tense too. `unknown-op` is a REFUSAL, and it is the one that lands
  // here: a model that hallucinates `workflow.squash_pr` is recorded before validation and refused,
  // so a present-tense line would assert an action this app has no code for.
  it("gives an un-phrased op the same tense as a phrased one", () => {
    const unphrased = (outcome: ConciergeToolActivity["outcome"]) =>
      conciergeActivityLine(activity({ domain: "workflow", op: "squash_pr", outcome }))?.text;
    expect(unphrased("running")).toBe("Using workflow · squash_pr");
    expect(unphrased("done")).toBe("Used workflow · squash_pr");
    expect(unphrased("refused")).toBe("Tried using workflow · squash_pr");
  });

  it("declines a known domain with no op at all", () => {
    expect(conciergeActivityLine(activity({ domain: "terminal", op: "" }))).toBeNull();
  });
});

describe("conciergeActivitySubject", () => {
  it("prefers the agent when a call carries both an agent and its project", () => {
    expect(conciergeActivitySubject({ agentId: "a1", projectId: "p1" })).toEqual({
      kind: "agent",
      agentId: "a1",
    });
  });

  it("reads a PR number and a project id", () => {
    expect(conciergeActivitySubject({ projectId: "p1", number: 753 })).toEqual({
      kind: "pr",
      number: 753,
    });
    expect(conciergeActivitySubject({ projectId: "p1" })).toEqual({
      kind: "project",
      projectId: "p1",
    });
  });

  // `args` is untyped JSON a model wrote. Nothing here may throw, and a shape it does not recognise
  // resolves to null — an indefinite phrase — rather than to the wrong subject.
  it("returns null for anything it does not recognise, without throwing", () => {
    expect(conciergeActivitySubject(undefined)).toBeNull();
    expect(conciergeActivitySubject("not an object")).toBeNull();
    expect(conciergeActivitySubject({ agentId: 42 })).toBeNull();
    expect(conciergeActivitySubject({ agentId: "" })).toBeNull();
    expect(conciergeActivitySubject({ number: Number.NaN })).toBeNull();
    expect(conciergeActivitySubject({ enabled: true })).toBeNull();
  });
});
