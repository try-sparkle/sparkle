// @vitest-environment jsdom
//
// The PER-TOOL AUTONOMY POLICY layer. These pin the properties the module exists to guarantee, in
// the order they matter:
//
//   1. NOTHING RESOLVES TO `allow` BY ACCIDENT — an unclassified name, an unreadable config value,
//      and every dangerous risk class must all resolve to something stricter. This is the whole
//      point of the layer, so it gets the most tests.
//   2. THE DEFAULTS ARE DERIVED from the domains' own risk maps, not hand-listed here — so the
//      assertions walk the CATALOG rather than naming tools, and a new tool is covered on the day
//      it is added rather than the day someone remembers this file.
//   3. THE TOOL SET COVERS ALL FOUR DOMAINS, exactly once each. The terminal domain's coverage is a
//      test rather than a typecheck (its descriptors' `name` is `string`), so that seam is asserted
//      explicitly against the descriptor list.
//   4. THE DECISION FUNCTION IS PURE — same inputs, same output, no store, no IO.
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  CONCIERGE_RISK_NOTE,
  CONCIERGE_TOOL_CATALOG,
  CONCIERGE_TOOL_DOMAINS,
  CONCIERGE_TOOL_GROUPS,
  CONCIERGE_TOOL_NAMES,
  DEFAULT_DECISION_BY_RISK,
  NO_TOOL_POLICY_OVERRIDES,
  POLICY_DECISIONS,
  TERMINAL_TOOL_NAMES,
  APP_TOOL_NAMES,
  TERMINAL_TOOL_RISK,
  asPolicyDecision,
  conciergeToolConfigPath,
  defaultDecisionFor,
  evaluateToolPolicy,
  isConciergeToolName,
  toToolPolicyOverrides,
  type ConciergeRiskClass,
  type ConciergeToolName,
} from "./policy";
import { CONCIERGE_TERMINAL_TOOLS } from "./terminal";
import { LIFECYCLE_OPS } from "./lifecycle";
import { REVIEW_OPS } from "./review";
import { WORKFLOW_OPERATIONS } from "./workflow";
import { EVENTS_OPS } from "./events";
import { WORKSPACE_OPS } from "./workspace";
import { ATTACHMENTS_OPS } from "./attachments";
import { SCREENSHOT_OPS } from "./screenshot";
import { BOARD_OPS } from "./board";
import { APPROVALS_OPS } from "./approvals";
import { PLANS_OPS } from "./plans";
import { DIFF_OPS } from "./diff";
import { FLEET_OPS } from "./fleet";
import { toConciergeToolPolicy } from "../../stores/settingsStore";

const NONE = { overrides: NO_TOOL_POLICY_OVERRIDES };

describe("nothing resolves to allow by accident", () => {
  it("a brand-new UNCLASSIFIED tool name does not resolve to allow", () => {
    // THE test this layer exists for. A name nobody classified must never come back permissive,
    // whatever it is called or however plausible it sounds.
    for (const name of [
      "teleport_agent",
      "delete_everything",
      "list_projects_v2",
      "read_agent_terminal_fast",
      "",
      "spawn_build_agent ", // trailing space — a near-miss, not a match
    ]) {
      const v = evaluateToolPolicy(name, NONE);
      expect(v.decision).not.toBe("allow");
      expect(v.decision).toBe("deny");
      expect(v.source).toBe("unclassified");
      expect(v.riskClass).toBeNull();
      expect(v.defaultDecision).toBeNull();
      expect(v.requiresConfirmation).toBe(false);
      expect(v.tool).toBe(name);
    }
  });

  it("an unclassified name stays denied even when the config tries to allow a DIFFERENT tool", () => {
    const v = evaluateToolPolicy("teleport_agent", {
      overrides: { list_projects: "allow", merge_pr: "allow" },
    });
    expect(v.decision).toBe("deny");
  });

  it("an UNREADABLE config value resolves to ask — never to the tool's default", () => {
    // `list_projects` defaults to allow. A typo'd rule is most likely someone TAKING permission
    // away, so falling back to the default would hand back exactly what they were removing.
    expect(defaultDecisionFor("list_projects")).toBe("allow");
    for (const bad of ["allwo", "yes", "true", "ALLOW", "Ask", " deny", "never", ""]) {
      const v = evaluateToolPolicy("list_projects", { overrides: { list_projects: bad } });
      expect(v.decision).toBe("ask");
      expect(v.source).toBe("unreadable-override");
      expect(v.overridden).toBe(true);
      expect(v.requiresConfirmation).toBe(true);
      expect(v.reason).toContain("config.toml");
    }
  });

  it("a non-string config value is dropped at the door and reads as no rule at all", () => {
    // Coercion drops it; the tool then resolves through its risk class, which is total. What it must
    // NOT do is arrive as a truthy value that some later `if` reads as permission.
    const overrides = toToolPolicyOverrides({ merge_pr: true, quit_app: 3, list_projects: null });
    expect(overrides).toEqual({});
    expect(evaluateToolPolicy("merge_pr", { overrides }).source).toBe("default");
    expect(evaluateToolPolicy("merge_pr", { overrides }).decision).toBe("ask");
  });

  it("no derived default is `deny` — refusing outright is only ever the human's choice", () => {
    for (const decision of Object.values(DEFAULT_DECISION_BY_RISK)) {
      expect(decision).not.toBe("deny");
    }
  });

  it("every irreversible / outward-facing / mutates-main / metered tool defaults to ask", () => {
    const mustAsk: readonly ConciergeRiskClass[] = [
      "irreversible",
      "outward-facing",
      "mutates-main",
      "costs-money",
      "rewrites-branch",
      "disruptive",
    ];
    const dangerous = CONCIERGE_TOOL_CATALOG.filter((t) => mustAsk.includes(t.riskClass));
    // If this ever hits zero the assertion below passes vacuously and stops meaning anything.
    expect(dangerous.length).toBeGreaterThan(5);
    for (const tool of dangerous) {
      expect(evaluateToolPolicy(tool.name, NONE).decision, tool.name).toBe("ask");
    }
  });

  it("read-only tools default to allow", () => {
    const readOnly = CONCIERGE_TOOL_CATALOG.filter((t) => t.riskClass === "read-only");
    expect(readOnly.length).toBeGreaterThan(0);
    for (const tool of readOnly) {
      expect(evaluateToolPolicy(tool.name, NONE).decision, tool.name).toBe("allow");
    }
  });

  it("the named dangerous operations are classified the way the domains classified them", () => {
    // A handful of spot-checks against the domain risk maps, so a translation bug (a vocabulary
    // arm mapped to the wrong class) is caught by NAME and not just by shape.
    const byName = new Map(CONCIERGE_TOOL_CATALOG.map((t) => [t.name, t]));
    expect(byName.get("discard_agent")?.riskClass).toBe("irreversible");
    expect(byName.get("merge_pr")?.riskClass).toBe("mutates-main");
    expect(byName.get("land_agent_branch")?.riskClass).toBe("mutates-main");
    expect(byName.get("push_agent_branch")?.riskClass).toBe("outward-facing");
    expect(byName.get("spawn_cloud_build_agent")?.riskClass).toBe("costs-money");
    expect(byName.get("quit_app")?.riskClass).toBe("irreversible");
    expect(byName.get("stop_project_agents")?.riskClass).toBe("disruptive");
    expect(byName.get("send_to_agent_terminal")?.riskClass).toBe("disruptive");
    expect(byName.get("list_projects")?.riskClass).toBe("read-only");
  });
});

describe("explicit rules — the three values", () => {
  it("honours allow / ask / deny for a tool the human set", () => {
    for (const decision of POLICY_DECISIONS) {
      const v = evaluateToolPolicy("merge_pr", { overrides: { merge_pr: decision } });
      expect(v.decision).toBe(decision);
      expect(v.source).toBe("override");
      expect(v.overridden).toBe(true);
      expect(v.requiresConfirmation).toBe(decision === "ask");
      expect(v.defaultDecision).toBe("ask");
    }
  });

  it("an explicit allow can loosen a dangerous default — that is the point of per-tool control", () => {
    expect(defaultDecisionFor("push_agent_branch")).toBe("ask");
    const v = evaluateToolPolicy("push_agent_branch", { overrides: { push_agent_branch: "allow" } });
    expect(v.decision).toBe("allow");
    expect(v.requiresConfirmation).toBe(false);
  });

  it("an explicit deny can tighten a permissive default", () => {
    expect(defaultDecisionFor("list_projects")).toBe("allow");
    const v = evaluateToolPolicy("list_projects", { overrides: { list_projects: "deny" } });
    expect(v.decision).toBe("deny");
    // `deny` is not "ask and say no": there is nothing to confirm.
    expect(v.requiresConfirmation).toBe(false);
  });

  it("one tool's rule never leaks onto another", () => {
    const overrides = { merge_pr: "allow" };
    expect(evaluateToolPolicy("merge_pr", { overrides }).decision).toBe("allow");
    expect(evaluateToolPolicy("land_agent_branch", { overrides }).decision).toBe("ask");
    expect(evaluateToolPolicy("land_agent_branch", { overrides }).source).toBe("default");
  });

  it("a rule for a name that is not a tool is inert — it cannot grant anything", () => {
    const overrides = { teleport_agent: "allow", not_a_tool: "allow" };
    expect(evaluateToolPolicy("teleport_agent", { overrides }).decision).toBe("deny");
    for (const name of CONCIERGE_TOOL_NAMES) {
      expect(evaluateToolPolicy(name, { overrides }).source).toBe("default");
    }
  });

  it("inherited object properties are not read as rules", () => {
    // `{}.constructor` and friends exist on every object literal; a naive `overrides[name]` lookup
    // would find them. No tool is named `constructor`, but the lookup must not resolve one either.
    const v = evaluateToolPolicy("constructor", NONE);
    expect(v.source).toBe("unclassified");
    expect(v.decision).toBe("deny");
  });
});

describe("the tool set is derived from the domains", () => {
  it("covers every domain and nothing else", () => {
    // `app` is the ORIGINAL sparkle-control ops, brought under the same policy (roborev 54226).
    // `board` and `approvals` are dispatched domains that the settings pane must also list — this
    // module's domain union is the SETTINGS vocabulary, deliberately wider than the wire one.
    expect(CONCIERGE_TOOL_GROUPS.map((g) => g.domain)).toEqual([
      "lifecycle",
      "review",
      "terminal",
      "attachments",
      "workflow",
      "events",
      "workspace",
      "screenshot",
      "board",
      "approvals",
      "plans",
      "diff",
      "fleet",
      "app",
    ]);
    expect(CONCIERGE_TOOL_DOMAINS.map((d) => d.id)).toEqual(
      CONCIERGE_TOOL_GROUPS.map((g) => g.domain),
    );
  });

  it("carries every operation each domain exports, in the domain's own order", () => {
    const of = (domain: string) =>
      CONCIERGE_TOOL_GROUPS.find((g) => g.domain === domain)!.tools.map((t) => t.name);
    expect(of("lifecycle")).toEqual([...LIFECYCLE_OPS]);
    expect(of("workflow")).toEqual([...WORKFLOW_OPERATIONS]);
    expect(of("workspace")).toEqual([...WORKSPACE_OPS]);
    expect(of("terminal")).toEqual([...TERMINAL_TOOL_NAMES]);
    expect(of("attachments")).toEqual([...ATTACHMENTS_OPS]);
  });

  it("the terminal seam agrees with the terminal domain's own descriptor list", () => {
    // The one domain whose coverage is a TEST rather than a typecheck: ConciergeToolDescriptor.name
    // is `string`, so there is no literal union to derive from. A fourth terminal tool lands here.
    expect([...TERMINAL_TOOL_NAMES].sort()).toEqual(
      CONCIERGE_TERMINAL_TOOLS.map((t) => t.name).sort(),
    );
    expect(Object.keys(TERMINAL_TOOL_RISK).sort()).toEqual([...TERMINAL_TOOL_NAMES].sort());
  });

  it("classifies the terminal domain consistently with each descriptor's `write` flag", () => {
    for (const d of CONCIERGE_TERMINAL_TOOLS) {
      const entry = CONCIERGE_TOOL_CATALOG.find((t) => t.name === d.name)!;
      expect(entry, d.name).toBeDefined();
      if (d.write) expect(entry.riskClass, d.name).not.toBe("read-only");
      else expect(entry.riskClass, d.name).toBe("read-only");
    }
  });

  it("has no duplicate tool names across domains", () => {
    // Names are bare (not domain-qualified) because they are config keys the user types. A collision
    // would make one domain's risk silently win the other's — so it has to be impossible, not rare.
    expect(new Set(CONCIERGE_TOOL_NAMES).size).toBe(CONCIERGE_TOOL_NAMES.length);
    expect(CONCIERGE_TOOL_NAMES.length).toBe(
      LIFECYCLE_OPS.length +
        REVIEW_OPS.length +
        TERMINAL_TOOL_NAMES.length +
        ATTACHMENTS_OPS.length +
        WORKFLOW_OPERATIONS.length +
        EVENTS_OPS.length +
        WORKSPACE_OPS.length +
        SCREENSHOT_OPS.length +
        BOARD_OPS.length +
        APPROVALS_OPS.length +
        PLANS_OPS.length +
        DIFF_OPS.length +
        FLEET_OPS.length +
        APP_TOOL_NAMES.length,
    );
  });

  it("every catalog entry is fully populated and internally consistent", () => {
    for (const tool of CONCIERGE_TOOL_CATALOG) {
      expect(isConciergeToolName(tool.name)).toBe(true);
      expect(tool.summary.length, tool.name).toBeGreaterThan(0);
      expect(CONCIERGE_RISK_NOTE[tool.riskClass], tool.name).toBeTruthy();
      expect(tool.defaultDecision).toBe(DEFAULT_DECISION_BY_RISK[tool.riskClass]);
      expect(tool.defaultDecision).toBe(defaultDecisionFor(tool.name));
      expect(tool.configPath).toBe(`concierge.tools.${tool.name}`);
      // The evaluation and the catalog must agree, or the pane shows one thing and the concierge
      // does another.
      const v = evaluateToolPolicy(tool.name, NONE);
      expect(v.decision, tool.name).toBe(tool.defaultDecision);
      expect(v.riskClass, tool.name).toBe(tool.riskClass);
      expect(v.domain, tool.name).toBe(tool.domain);
    }
  });

  it("resolves every tool in the catalog — none falls through to unclassified", () => {
    for (const name of CONCIERGE_TOOL_NAMES) {
      expect(evaluateToolPolicy(name, NONE).source, name).not.toBe("unclassified");
    }
  });
});

describe("purity", () => {
  it("is deterministic and does not mutate the overrides it is given", () => {
    const overrides = { merge_pr: "deny", list_projects: "allow" };
    const snapshot = JSON.stringify(overrides);
    const a = evaluateToolPolicy("merge_pr", { overrides });
    const b = evaluateToolPolicy("merge_pr", { overrides });
    expect(a).toEqual(b);
    expect(JSON.stringify(overrides)).toBe(snapshot);
  });

  it("the empty override table is frozen, so a caller cannot poison the shared default", () => {
    expect(Object.isFrozen(NO_TOOL_POLICY_OVERRIDES)).toBe(true);
  });

  it("every evaluation carries a non-empty reason a human could read", () => {
    const samples: string[] = [...CONCIERGE_TOOL_NAMES, "teleport_agent"];
    for (const name of samples) {
      const v = evaluateToolPolicy(name, { overrides: { [name]: "nonsense" } });
      expect(v.reason.length, name).toBeGreaterThan(10);
    }
  });
});

describe("value + path helpers", () => {
  it("narrows only the three real values", () => {
    expect(asPolicyDecision("allow")).toBe("allow");
    expect(asPolicyDecision("ask")).toBe("ask");
    expect(asPolicyDecision("deny")).toBe("deny");
    for (const bad of ["Allow", "always", "never", "", null, undefined, 1, true, {}]) {
      expect(asPolicyDecision(bad)).toBeNull();
    }
  });

  it("builds the dotted [concierge.tools] path", () => {
    expect(conciergeToolConfigPath("merge_pr")).toBe("concierge.tools.merge_pr");
  });

  it("coerces a config payload, keeping strings verbatim", () => {
    expect(toToolPolicyOverrides({ merge_pr: "deny", quit_app: "allwo" })).toEqual({
      merge_pr: "deny",
      quit_app: "allwo",
    });
    expect(toToolPolicyOverrides(undefined)).toEqual({});
    expect(toToolPolicyOverrides(null)).toEqual({});
    expect(toToolPolicyOverrides("nope")).toEqual({});
    expect(toToolPolicyOverrides(42)).toEqual({});
  });
});

describe("the settings-store mirror agrees with this module's coercion", () => {
  // settingsStore can't IMPORT `toToolPolicyOverrides` — policy.ts pulls in the tool domains, and
  // lifecycle.ts imports the store, so a value import would close an import cycle. It carries a
  // structural twin instead. This is what stops the twin from drifting.
  it("produces the same result on every shape a config payload can take", () => {
    const cases: unknown[] = [
      undefined,
      null,
      {},
      "nope",
      42,
      { merge_pr: "deny" },
      { merge_pr: "deny", quit_app: "allwo" },
      { merge_pr: true, quit_app: 3, list_projects: "ask" },
      { a: "", b: "ask", c: null, d: undefined },
    ];
    for (const raw of cases) {
      expect(toConciergeToolPolicy(raw), JSON.stringify(raw)).toEqual(toToolPolicyOverrides(raw));
    }
  });
});

describe("the type-level guarantee, exercised at runtime", () => {
  it("the risk table is total over the tool union", () => {
    // `RISK_BY_TOOL` is private; the catalog is its public shadow. A tool missing from it would be
    // a compile error at the `Record<ConciergeToolName, …>` annotation — this asserts the runtime
    // consequence, so the two can't disagree.
    const named: ConciergeToolName[] = [
      "spawn_build_agent",
      "discard_agent",
      "merge_pr",
      "quit_app",
      "send_to_agent_terminal",
    ];
    for (const name of named) {
      expect(CONCIERGE_TOOL_CATALOG.some((t) => t.name === name), name).toBe(true);
    }
  });
});
