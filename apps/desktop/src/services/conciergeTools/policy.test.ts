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
  isForeignSlug,
  isPinnedMergeProtectedSlug,
  MERGE_PROTECTED_SLUGS,
  ownerOfSlug,
  POLICY_STRICTNESS,
  projectPolicyContextFor,
  strictestDecision,
  isConciergeToolName,
  perCallRiskFor,
  toToolPolicyOverrides,
  type ConciergeRiskClass,
  type ConciergeToolName,
  SUMMARY_BY_TOOL,
} from "./policy";
import { WIDE_HISTORY_SCOPE } from "@sparkle/core";
import { CONCIERGE_TERMINAL_TOOLS } from "./terminal";
import { LIFECYCLE_OPS } from "./lifecycle";
import { REVIEW_OPS } from "./review";
import { WORKFLOW_OPERATIONS } from "./workflow";
import { EVENTS_OPS } from "./events";
import { WORKSPACE_OPS } from "./workspace";
import { ATTACHMENTS_OPS } from "./attachments";
import { SCREENSHOT_OPS } from "./screenshot";
import { PREVIEW_INSPECT_OPS } from "./previewInspect";
import { BOARD_OPS } from "./board";
import { APPROVALS_OPS } from "./approvals";
import { PLANS_OPS } from "./plans";
import { DIFF_OPS } from "./diff";
import { FLEET_OPS } from "./fleet";
import { RESEARCH_OPS } from "./research";
import { CHIEF_CALL_TOOL_ARG, CHIEF_OPS, CHIEF_RISK, chiefCallToolName } from "./chief";
import { CHIEF_DESTRUCTIVE_TOOLS } from "../chiefScope";
import { ACCOUNTS_OPS } from "./accounts";
import { MEMORY_OPS } from "./memory";
import { DISPATCH_MEMORY_OPS } from "./dispatchMemory";
import { PUBLISH_OPS } from "./publish";
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

// -----------------------------------------------------------------------------------------------
// PER-CALL RISK. TWO ops have a danger that lives in their ARGUMENTS. `search_history`: `scope:
// "all"` also reads `concierge`-sourced rows — the founder's own conversations with the minder —
// while the default searches build history, and the founder's call is that those rows are recorded
// and findable by him, and not silently vacuumable by the model. `chief_call`: the hatch NAMES the
// upstream verb it wants, so its `tool` argument is the only thing that says whether the call
// deletes a client's data (its cases are in the Chief block below).
// -----------------------------------------------------------------------------------------------
describe("risk that depends on the CALL, not on the op name", () => {
  const withScope = (scope?: unknown) => ({
    overrides: NO_TOOL_POLICY_OVERRIDES,
    args: scope === undefined ? { query: "widget" } : { query: "widget", scope },
  });

  it("a default-scope search stays read-only and auto-allows", () => {
    // The PAIRED half of the escalation test below. Without it, "scope: all asks" is satisfied by a
    // policy that asks on every search — which would be a regression, not a feature.
    for (const ctx of [NONE, withScope(), withScope("default")]) {
      const v = evaluateToolPolicy("search_history", ctx);
      expect(v.riskClass).toBe("read-only");
      expect(v.decision).toBe("allow");
      expect(v.requiresConfirmation).toBe(false);
    }
  });

  it("scope 'all' escalates the same op to privacy-sensitive and therefore to ask", () => {
    const v = evaluateToolPolicy("search_history", withScope("all"));
    expect(v.riskClass).toBe("privacy-sensitive");
    expect(v.decision).toBe("ask");
    expect(v.requiresConfirmation).toBe(true);
    expect(v.defaultDecision).toBe("ask");
    // Still the derived default — no config entry was involved in tightening it.
    expect(v.source).toBe("default");
    expect(v.overridden).toBe(false);
  });

  it("perCallRiskFor is total over garbage arguments and never escalates on a near-miss", () => {
    // The policy is consulted BEFORE the registry's zod runs, so this sees raw model JSON. Anything
    // it cannot positively recognise as the wider request must fall through to the name-keyed
    // class — the safe direction, since the registry then refuses the malformed call anyway.
    for (const args of [
      undefined,
      null,
      "all",
      42,
      ["all"],
      { scope: "ALL" },
      { scope: ["all"] },
      { scope: true },
      { scope: null },
      { scope: "all " },
      { notScope: "all" },
    ]) {
      expect(perCallRiskFor("search_history", args), JSON.stringify(args) ?? "undefined").toBeNull();
    }
    expect(perCallRiskFor("search_history", { scope: "all" })).toBe("privacy-sensitive");
  });

  it("no OTHER tool grows a per-call opinion from the same argument", () => {
    // `scope` is meaningful to exactly one op. A blanket "any call carrying scope:all is
    // privacy-sensitive" would be the easy implementation and would mislabel unrelated calls.
    for (const name of CONCIERGE_TOOL_NAMES) {
      if (name === "search_history") continue;
      expect(perCallRiskFor(name, { scope: "all" }), name).toBeNull();
    }
    // …and an unclassified name gets no opinion either, rather than throwing.
    expect(perCallRiskFor("teleport_agent", { scope: "all" })).toBeNull();
  });

  it("does not change what the SETTINGS PANE says about the tool", () => {
    // The pane asks about a TOOL, not a call, and it must keep rendering the row a human can act on
    // — a permanently-asking `search_history` row would misdescribe the common case.
    const entry = CONCIERGE_TOOL_CATALOG.find((t) => t.name === "search_history");
    expect(entry?.riskClass).toBe("read-only");
    expect(entry?.defaultDecision).toBe("allow");
    // But its summary must NOT be the bare read-only note, because that note is what would headline
    // the approval card raised for `scope: "all"`.
    expect(entry?.summary).not.toBe(CONCIERGE_RISK_NOTE["read-only"]);
    expect(entry?.summary).toContain("scope");
  });

  // roborev 61894-H1. The first cut let an explicit `allow` cover the wide call, on the reasoning
  // that a standing yes is the human's to give. It is not, HERE, because the yes was never asked
  // for the wide case: the bulk "Allow every concierge tool?" dialog derives its privacy warning
  // from the CATALOG's riskClass, which this op deliberately keeps at `read-only`, so one click
  // granted unprompted reads of the founder's private conversations while naming only screen
  // capture. The escalation is now a FLOOR.
  it("an explicit human allow does NOT cover the escalated call", () => {
    const overrides = { search_history: "allow" };
    // …but it does cover the ordinary one, which is what someone setting that row is asking for.
    const narrow = evaluateToolPolicy("search_history", {
      overrides,
      args: { query: "widget" },
    });
    expect(narrow.decision).toBe("allow");
    expect(narrow.source).toBe("override");

    const wide = evaluateToolPolicy("search_history", {
      overrides,
      args: { query: "widget", scope: "all" },
    });
    expect(wide.decision).toBe("ask");
    expect(wide.source).toBe("per-call-escalation");
    expect(wide.riskClass).toBe("privacy-sensitive");
    expect(wide.requiresConfirmation).toBe(true);
    // The human DID set a rule; saying otherwise would make the pane show this row as untouched.
    expect(wide.overridden).toBe(true);
    // And the sentence has to explain the override was not ignored but out-scoped.
    expect(wide.reason).toContain("You allowed");
  });

  it("the floor only ever tightens — it never turns a deny or an ask into something looser", () => {
    for (const rule of ["deny", "ask"] as const) {
      const v = evaluateToolPolicy("search_history", {
        overrides: { search_history: rule },
        args: { query: "widget", scope: "all" },
      });
      expect(v.decision, rule).toBe(rule);
      expect(v.source, rule).toBe("override");
    }
  });

  it("the floor touches nothing but the escalated op", () => {
    // A tool with no per-call rule must still honour an allow, or the floor has leaked.
    const v = evaluateToolPolicy("push_agent_branch", {
      overrides: { push_agent_branch: "allow" },
      args: { scope: "all" },
    });
    expect(v.decision).toBe("allow");
    expect(v.source).toBe("override");
  });

  it("the row's summary promises what the floor delivers", () => {
    // The summary tells the human the wide scope asks first EVEN IF they allow the tool. That is a
    // claim about the rule above, so the two are pinned together — copy is code.
    const entry = CONCIERGE_TOOL_CATALOG.find((t) => t.name === "search_history");
    expect(entry?.summary).toContain("even if you allow this tool");
    expect(
      evaluateToolPolicy("search_history", {
        overrides: { search_history: "allow" },
        args: { query: "w", scope: "all" },
      }).decision,
    ).toBe("ask");
  });

  it("every domain that publishes prose still reaches the catalog — no spread can be dropped silently", () => {
    // roborev 61938 then 61960. SUMMARY_BY_TOOL is assembled from seven spreads on a block of
    // adjacent lines that has already been a merge conflict once and was resolved by hand. Dropping
    // any one is SILENT: `entryFor` falls back to `CONCIERGE_RISK_NOTE[riskClass]`, so the row
    // survives with generic prose, and the "summary is non-empty" check below is satisfied by that
    // fallback. The screenshot rows are the worst case — `privacy-sensitive`, whose summaries exist
    // precisely because a generic risk note is the wrong headline on a consent card.
    //
    // ── WHY THIS ITERATES THE OP LISTS AND NOT `SUMMARY_BY_TOOL` ──────────────────────────────────
    // The obvious version — walk `SUMMARY_BY_TOOL` and check each entry reaches the catalog — is
    // VACUOUS, and mutation-checking is the only reason that surfaced. The catalog is BUILT from
    // that map, so deleting a spread removes the entry from both sides of the comparison and the
    // assertion simply iterates fewer items. It passed with `...SCREENSHOT_TOOL_SUMMARY` and the
    // workflow line deleted. A guard derived from the expression it guards cannot detect its own
    // removal; the domains' OPS lists are the independent source of truth, so they are what this
    // walks.
    const prosePublishing: readonly (readonly [string, readonly string[]])[] = [
      ["research", RESEARCH_OPS],
      ["accounts", ACCOUNTS_OPS],
      ["memory", MEMORY_OPS],
      ["dispatch_memory", DISPATCH_MEMORY_OPS],
      ["screenshot", SCREENSHOT_OPS],
      ["attachments", ATTACHMENTS_OPS],
      ["workflow", WORKFLOW_OPERATIONS],
      ["terminal", TERMINAL_TOOL_NAMES],
      ["app", APP_TOOL_NAMES],
      ["chief", CHIEF_OPS],
      ["workspace(search_history)", ["search_history"]],
    ];
    for (const [domain, ops] of prosePublishing) {
      expect(ops.length, domain).toBeGreaterThan(0);
      for (const op of ops) {
        const entry = CONCIERGE_TOOL_CATALOG.find((t) => t.name === op);
        expect(entry, `${domain}/${op}`).toBeTruthy();
        // The fallback is the tell: a dropped spread leaves the row on its risk note.
        expect(entry!.summary, `${domain}/${op}`).not.toBe(CONCIERGE_RISK_NOTE[entry!.riskClass]);
        expect(entry!.summary, `${domain}/${op}`).toBe(
          (SUMMARY_BY_TOOL as Record<string, string>)[op],
        );
      }
    }
    // …plus two content-level pins, because reaching the catalog is not the same as saying the thing
    // that matters: someone deciding whether to gate `dispatch` needs to know it spends money.
    expect(CONCIERGE_TOOL_CATALOG.find((t) => t.name === "dispatch")?.summary).toContain("metered");
    // And `search_history`'s row must name the scope value that actually triggers the card. This is
    // the one summary that describes an ARGUMENT rather than a verb, so it is the one that can go
    // quietly wrong: a rename of the scope vocabulary would leave this sentence telling the human to
    // expect a value the `.strict()` zod enum refuses. Asserted against the shared constant, not the
    // literal — a copy of the literal here would rename right along with the bug.
    expect(CONCIERGE_TOOL_CATALOG.find((t) => t.name === "search_history")?.summary).toContain(
      `scope: "${WIDE_HISTORY_SCOPE}"`,
    );
  });

  it("an explicit human deny still wins at scope all", () => {
    const v = evaluateToolPolicy("search_history", {
      overrides: { search_history: "deny" },
      args: { query: "widget", scope: "all" },
    });
    expect(v.decision).toBe("deny");
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

  // THE ACCOUNTS GATE, asserted where it is actually decided. accounts.test.ts pins the WORD
  // (`switch_all` is `disruptive`), but the word only matters because of the translation and the
  // derivation this module performs on it — and both are places the row could silently land on
  // `routine` while that test stayed green. What must be true is this: moving every agent between
  // Anthropic logins asks a human first, and merely reading headroom does not.
  it("switch_all asks a human; read_usage does not", () => {
    expect(defaultDecisionFor("switch_all")).toBe("ask");
    expect(evaluateToolPolicy("switch_all", NONE).requiresConfirmation).toBe(true);
    expect(defaultDecisionFor("read_usage")).toBe("allow");
  });

  // THE RE-ARM LEVER RUNS UNATTENDED, by founder ruling on 2026-08-13. It shipped classified
  // `irreversible`, which derives to `ask` — so the one lever built to let a machine unstick a
  // stalled agent could not fire unless a human was awake to approve it, which is the situation it
  // was built to end. Nine goals sat escalated simultaneously with no machine able to touch any.
  //
  // Asserted as a PAIR against `set_agent_goal_met`, deliberately. Both halves of the founder's ask
  // — put an agent back to work, and close a goal that is genuinely finished — have to run without
  // a human, or the queue drains at one end and refills at the other. A single assertion here would
  // stay green with the other half still gated.
  //
  // The guard that replaces the card is the BOUND, not trust: `MAX_CONCIERGE_REARMS` caps this at
  // two per goal, exhaustion re-notifies the human, and only a human's typing refills the
  // allowance. See `conciergeRearmGoal` / `resetGoalRetries`.
  it("the concierge's goal levers run unattended — the bound is the guard, not an approval card", () => {
    expect(defaultDecisionFor("set_agent_escalation")).toBe("allow");
    expect(evaluateToolPolicy("set_agent_escalation", NONE).requiresConfirmation).toBe(false);
    expect(defaultDecisionFor("set_agent_goal_met")).toBe("allow");
    expect(evaluateToolPolicy("set_agent_goal_met", NONE).requiresConfirmation).toBe(false);
  });

  // …and the human can still take it back. Autonomy by default is not autonomy by fiat: the founder
  // setting this tool to Ask must still produce a card, or the reclassification above has quietly
  // removed a control rather than changed its default.
  it("a human can put the approval card back on the re-arm lever", () => {
    const v = evaluateToolPolicy("set_agent_escalation", {
      overrides: { set_agent_escalation: "ask" },
    });
    expect(v.decision).toBe("ask");
    expect(v.requiresConfirmation).toBe(true);
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
      "preview_inspect",
      "board",
      "approvals",
      "plans",
      "diff",
      "fleet",
      "research",
      "chief",
      "accounts",
      "memory",
      "dispatch_memory",
      "publish",
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
    expect(of("chief")).toEqual([...CHIEF_OPS]);
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
        PREVIEW_INSPECT_OPS.length +
        BOARD_OPS.length +
        APPROVALS_OPS.length +
        PLANS_OPS.length +
        DIFF_OPS.length +
        FLEET_OPS.length +
        RESEARCH_OPS.length +
        CHIEF_OPS.length +
        ACCOUNTS_OPS.length +
        MEMORY_OPS.length +
        DISPATCH_MEMORY_OPS.length +
        PUBLISH_OPS.length +
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

// -----------------------------------------------------------------------------------------------
// THE CHIEF DOMAIN (bead sparkle-8rr0c). Chief holds live client work, so the split the concierge is
// judged on is read-versus-write, not tool-by-tool: reading a client's project changes nothing, and
// writing to one puts content in front of a person who is not the user.
//
// Every assertion here reads the DECISION back out of `evaluateToolPolicy` rather than checking that
// a row exists in the map. An existence check would have passed against the map alone — before the
// domain was wired into `RISK_BY_TOOL`, `DOMAIN_BY_TOOL` and `NAMES_BY_DOMAIN` — which is precisely
// the state in which no Chief call is governed by anything.
// -----------------------------------------------------------------------------------------------
describe("the Chief domain derives its decisions from its own risk map", () => {
  const READS = [
    "chief_list_projects",
    "chief_list_assets",
    "chief_get_asset",
    "chief_list_chats",
    "chief_list_messages",
    "chief_list_memories",
    "chief_list_skills",
  ] as const;

  const WRITES = [
    "chief_create_chat",
    "chief_send_message",
    "chief_upload_file",
    "chief_create_memory",
  ] as const;

  it("names every Chief op exactly once, so a new one cannot arrive untested", () => {
    // The two lists below are written out by hand ON PURPOSE — deriving them from `CHIEF_RISK` would
    // make every assertion in this block a restatement of the map it is supposed to be checking.
    // This is the guard that keeps the hand-written lists honest instead.
    expect([...READS, ...WRITES, "chief_call"].sort()).toEqual([...CHIEF_OPS].sort());
    expect(Object.keys(CHIEF_RISK).sort()).toEqual([...CHIEF_OPS].sort());
  });

  it("a READ Chief tool resolves to allow", () => {
    for (const name of READS) {
      const v = evaluateToolPolicy(name, NONE);
      expect(v.decision, name).toBe("allow");
      expect(v.riskClass, name).toBe("read-only");
      expect(v.domain, name).toBe("chief");
      expect(v.source, name).toBe("default");
      expect(v.requiresConfirmation, name).toBe(false);
    }
  });

  it("a WRITE Chief tool resolves to ask — it lands in a real client's project", () => {
    for (const name of WRITES) {
      const v = evaluateToolPolicy(name, NONE);
      expect(v.decision, name).toBe("ask");
      expect(v.riskClass, name).toBe("outward-facing");
      expect(v.domain, name).toBe("chief");
      expect(v.defaultDecision, name).toBe("ask");
      expect(v.requiresConfirmation, name).toBe(true);
    }
  });

  it("`chief_call` resolves to ask — an escape hatch cannot be classified read-only", () => {
    // It names an arbitrary upstream tool, so its risk is not knowable from the call site. If this
    // ever auto-allowed, every verb the eleven named tools were split apart to gate would be
    // reachable through one un-prompted call.
    const v = evaluateToolPolicy("chief_call", NONE);
    expect(v.decision).toBe("ask");
    expect(v.riskClass).not.toBe("read-only");
    expect(v.requiresConfirmation).toBe(true);
  });

  it("and its arguments cannot talk it down — naming a read tool is still ask", () => {
    // The per-call table only ever TIGHTENS (see `perCallRiskFor`); a hatch that argued its way to
    // `allow` on model-supplied arguments would be the model approving itself.
    for (const args of [
      { tool: "list_projects" },
      { tool: "list_chats", arguments: {} },
      { tool: "delete_chat" },
    ]) {
      const v = evaluateToolPolicy("chief_call", { overrides: NO_TOOL_POLICY_OVERRIDES, args });
      expect(v.decision, JSON.stringify(args)).toBe("ask");
    }
    expect(perCallRiskFor("chief_call", { tool: "list_projects" })).toBeNull();
  });

  // roborev 63041, Medium. `chief_call` is the ONLY route the concierge has to Chief's destructive
  // verbs — `checkChiefTool` passes a concierge caller unconditionally by design — so with the hatch
  // classified by NAME alone, one `chief_call = "allow"` (or one click on "Allow every concierge
  // tool?") granted unprompted, permanent destruction of a real client's data. Same shape and same
  // remedy as the `search_history` floor above: an `allow` is a statement about the tool's ordinary
  // use, and the destructive call is by construction not what the human was shown when they set it.
  it("an explicit ALLOW does not cover a chief_call naming a DESTRUCTIVE verb", () => {
    const overrides = { chief_call: "allow" };
    // The ordinary hatch call IS covered — that is what someone setting that row is asking for.
    const ordinary = evaluateToolPolicy("chief_call", {
      overrides,
      args: { tool: "list_chats" },
    });
    expect(ordinary.decision).toBe("allow");
    expect(ordinary.source).toBe("override");

    for (const tool of [...CHIEF_DESTRUCTIVE_TOOLS]) {
      const v = evaluateToolPolicy("chief_call", { overrides, args: { tool } });
      expect(v.decision, tool).toBe("ask");
      expect(v.source, tool).toBe("per-call-escalation");
      expect(v.riskClass, tool).toBe("irreversible");
      expect(v.requiresConfirmation, tool).toBe(true);
      // The human DID set a rule; saying otherwise would render the row as untouched.
      expect(v.overridden, tool).toBe(true);
    }
    // Non-vacuity: an empty destructive set would make the loop above prove nothing.
    expect(CHIEF_DESTRUCTIVE_TOOLS.size).toBeGreaterThan(5);
  });

  it("the destructive floor applies to the DEFAULT decision too, and says so on the card", () => {
    // With no rule at all the hatch already asks — so the fact this test pins is not the decision
    // but the RISK CLASS the approval card is headlined with: "outward-facing" describes a push,
    // and what is about to happen is permanent deletion of someone else's data.
    const v = evaluateToolPolicy("chief_call", {
      overrides: NO_TOOL_POLICY_OVERRIDES,
      args: { tool: "delete_chat" },
    });
    expect(v.decision).toBe("ask");
    expect(v.riskClass).toBe("irreversible");
    expect(v.defaultDecision).toBe("ask");
    expect(v.reason).toContain(CONCIERGE_RISK_NOTE.irreversible);
  });

  it("the floor never fires on a near-miss, and is total over garbage arguments", () => {
    // `args` reaches the policy RAW — before the registry's zod — so every reader must be total, and
    // anything it cannot positively recognise must escalate NOTHING. That is safe in this direction
    // only: falling through lands on `outward-facing`, which already asks.
    for (const args of [
      undefined,
      null,
      "delete_chat",
      42,
      ["delete_chat"],
      { tool: ["delete_chat"] },
      { tool: true },
      { tool: null },
      { tool: "" },
      { notTool: "delete_chat" },
      { tool: "list_chats" },
      { tool: "create_chat" },
      { tool: "send_message" },
    ]) {
      expect(perCallRiskFor("chief_call", args), JSON.stringify(args) ?? "undefined").toBeNull();
    }
  });

  it("DOES escalate an unlisted verb that is shaped like a destruction", () => {
    // `delete_chat_v2` was asserted here as a "near-miss" that must NOT fire, back when the floor
    // read a bare 13-name list. That reading is now the wrong one (roborev 63036/63043): the list is
    // a denylist over a vocabulary Chief owns, so everything nobody enumerated was permitted — and
    // "permitted" for a concierge with `chief_call = "allow"` means deleting a real client's data
    // with no approval. `isDestructiveChiefTool` layers a structural rule over the list, so an
    // unrecognised `delete_*` from a future Chief release asks instead of running. Being wrong in
    // this direction costs one approval click; being wrong in the other cost the data.
    for (const tool of [
      "delete_chat_v2",
      "update_memory",
      "remove_project_member",
      "archive_chat",
      "revoke_api_key",
    ]) {
      expect(perCallRiskFor("chief_call", { tool }), tool).toBe("irreversible");
    }
  });

  it("the same verb in a different coat still escalates — padding, case, the wire prefix", () => {
    // roborev 63045. These are not near-misses, they are spellings: a model that types the MCP wire
    // name or shouts the verb is asking for the same deletion. The floor normalizes (chief.ts's
    // `normalizeChiefToolName`) rather than comparing raw, which is deliberately STRICTER than the
    // frozen contract's own `checkChiefTool` — matching more names can only ask more often.
    for (const tool of [
      "delete_chat",
      " delete_chat ",
      "DELETE_CHAT",
      "Delete_Chat",
      "mcp__chief__delete_chat",
      "  MCP__CHIEF__delete_chat\t",
    ]) {
      expect(perCallRiskFor("chief_call", { tool }), tool).toBe("irreversible");
      expect(
        evaluateToolPolicy("chief_call", { overrides: { chief_call: "allow" }, args: { tool } })
          .decision,
        tool,
      ).toBe("ask");
    }
  });

  it("reads the tool name through the SHARED argument key, not a literal spelled here", () => {
    // The key is a constant in chief.ts because the registry's zod schema (another file, another
    // author) has to agree with this reader. A schema that shipped `toolName` would make the floor
    // return null silently and the `allow` cover the delete again — with fixtures like the ones
    // above still green, because they would be matching the reader rather than the producer.
    expect(CHIEF_CALL_TOOL_ARG).toBe("tool");
    expect(chiefCallToolName({ [CHIEF_CALL_TOOL_ARG]: "delete_chat" })).toBe("delete_chat");
    expect(perCallRiskFor("chief_call", { [CHIEF_CALL_TOOL_ARG]: "delete_chat" })).toBe(
      "irreversible",
    );
  });

  it("no OTHER Chief tool grows an opinion from a `tool` argument", () => {
    // A blanket "any call naming a destructive verb is irreversible" would be the easy
    // implementation and would mislabel calls that cannot reach one — the first-class ops take no
    // `tool` argument at all.
    for (const name of CHIEF_OPS) {
      if (name === "chief_call") continue;
      expect(perCallRiskFor(name, { tool: "delete_chat" }), name).toBeNull();
    }
  });

  it("the hatch's row promises what the floor delivers", () => {
    // Copy is code, and this row's sentence is a claim about the rule above it — the same pairing
    // `search_history`'s summary and floor are held to.
    const entry = CONCIERGE_TOOL_CATALOG.find((t) => t.name === "chief_call");
    expect(entry?.summary).toContain("even if you allow this tool");
    expect(
      evaluateToolPolicy("chief_call", {
        overrides: { chief_call: "allow" },
        args: { tool: "delete_chat" },
      }).decision,
    ).toBe("ask");
  });

  it("an UNREADABLE rule for a Chief tool resolves to ask, not to its allow default", () => {
    // Same property as `list_projects` above, asserted on this domain because its reads are the ones
    // whose default is permissive: a typo'd rule is most likely someone taking that permission away.
    expect(defaultDecisionFor("chief_list_chats")).toBe("allow");
    for (const bad of ["allwo", "read-only", "ALLOW", "true", ""]) {
      const v = evaluateToolPolicy("chief_list_chats", { overrides: { chief_list_chats: bad } });
      expect(v.decision, bad).toBe("ask");
      expect(v.source, bad).toBe("unreadable-override");
      expect(v.requiresConfirmation, bad).toBe(true);
    }
  });

  it("an unknown chief_* name is DENIED — including the destructive verbs", () => {
    // The destructive Chief tools are deliberately not first-class concierge tools (chiefScope.ts
    // refuses them for build agents; the concierge reaches them only through `chief_call`). So a
    // model that invents the obvious name for one must be refused outright rather than prompted
    // about — property 2 of this module's header, on the names most worth getting right.
    for (const name of [
      "chief_delete_chat",
      "chief_delete_memory",
      "chief_update_project",
      "chief_create_project_invitation",
      "chief_send_message_v2",
      "chief_",
      "chief_list_chats ", // trailing space — a near-miss, not a match
    ]) {
      const v = evaluateToolPolicy(name, NONE);
      expect(v.decision, name).toBe("deny");
      expect(v.source, name).toBe("unclassified");
      expect(v.riskClass, name).toBeNull();
    }
  });

  it("an override for an unknown chief_* name cannot grant it anything", () => {
    const v = evaluateToolPolicy("chief_delete_chat", {
      overrides: { chief_delete_chat: "allow", chief_list_chats: "allow" },
    });
    expect(v.decision).toBe("deny");
  });

  it("the human can still gate a Chief read or wave a Chief write through", () => {
    // The derived defaults are a starting point, not the mechanism — per-tool control is the point.
    expect(
      evaluateToolPolicy("chief_list_messages", { overrides: { chief_list_messages: "deny" } })
        .decision,
    ).toBe("deny");
    expect(
      evaluateToolPolicy("chief_send_message", { overrides: { chief_send_message: "allow" } })
        .decision,
    ).toBe("allow");
  });

  it("every Chief row says whose data it touches, not just that it observes something", () => {
    // Copy is code: the risk-note fallback ("Observes only — changes nothing") is true of a Chief
    // read and useless on a settings row about a client's project. The writes matter more — the
    // `outward-facing` note talks about a push and a pull request, which is the wrong description of
    // a message someone will receive.
    for (const name of CHIEF_OPS) {
      const entry = CONCIERGE_TOOL_CATALOG.find((t) => t.name === name)!;
      expect(entry, name).toBeTruthy();
      expect(entry.summary, name).not.toBe(CONCIERGE_RISK_NOTE[entry.riskClass]);
    }
    const say = (name: string) => CONCIERGE_TOOL_CATALOG.find((t) => t.name === name)!.summary;
    expect(say("chief_send_message")).toContain("client");
    expect(say("chief_list_projects")).toContain("Chief");
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

// ---------------------------------------------------------------------------------------------
// PER-PROJECT POLICY — the strictness lattice (bead sparkle-gylxbo)
// ---------------------------------------------------------------------------------------------

describe("THE GOAL — one global tier, two different answers, in one test", () => {
  it("merge_pr is allow in drodio/sparkle and deny in plow-pbc/tkmx-server at the same time", () => {
    // One global rule. This is the whole point: today it has to be pinned to `ask` for everyone
    // because one tier cannot hold both facts below.
    const overrides = { merge_pr: "allow" } as const;
    const ownOrgs = ["drodio"];

    const own = evaluateToolPolicy("merge_pr", {
      overrides,
      project: projectPolicyContextFor("drodio/sparkle", ownOrgs, {}),
    });
    const theirs = evaluateToolPolicy("merge_pr", {
      overrides,
      project: projectPolicyContextFor("plow-pbc/tkmx-server", ownOrgs, {}),
    });

    expect(own.decision).toBe("allow");
    expect(theirs.decision).toBe("deny");
  });
});

describe("THE SECURITY PROPERTY — a project may only ever TIGHTEN", () => {
  it("project allow + global deny is deny", () => {
    // The inverse of the goal, and the reason the whole layer is safe to expose to a hand-edited
    // file: there is no arrangement of project inputs that widens what the human granted globally.
    // Written as its own named test rather than a row in the table below, because a table row that
    // stops running is invisible and this is the one property nothing else re-checks.
    const evaluation = evaluateToolPolicy("merge_pr", {
      overrides: { merge_pr: "deny" },
      project: projectPolicyContextFor("drodio/sparkle", ["drodio"], {
        "drodio/sparkle": { merge_pr: "allow" },
      }),
    });
    expect(evaluation.decision).toBe("deny");
    // …and the ATTRIBUTION says the global rule decided it, not the project's — otherwise the pane
    // would point the human at a project rule that changed nothing.
    expect(evaluation.source).toBe("override");
    expect(evaluation.project?.tightened).toBe(false);
    expect(evaluation.project?.inheritedDecision).toBe("deny");
  });

  it("a project allow cannot lift a foreign repo's mutates-main floor", () => {
    const evaluation = evaluateToolPolicy("merge_pr", {
      overrides: { merge_pr: "allow" },
      project: projectPolicyContextFor("someone-else/thing", ["drodio"], {
        "someone-else/thing": { merge_pr: "allow" },
      }),
    });
    expect(evaluation.decision).toBe("ask");
    expect(evaluation.source).toBe("foreign-repo");
  });

  it("a project allow cannot lift a PINNED repo's deny", () => {
    const evaluation = evaluateToolPolicy("merge_pr", {
      // Even with the org claimed as our own AND an explicit project allow, the shipped pin holds.
      overrides: { merge_pr: "allow" },
      project: projectPolicyContextFor("plow-pbc/tkmx-client", ["plow-pbc", "drodio"], {
        "plow-pbc/tkmx-client": { merge_pr: "allow" },
      }),
    });
    expect(evaluation.decision).toBe("deny");
    expect(evaluation.source).toBe("pinned-repo");
  });
});

describe("ADDITIVE ONLY — no project context means today's answer, byte for byte", () => {
  it("every tool in the catalog evaluates identically with and without an empty-ish project", () => {
    // The claim is about the SHAPE too, not just the decision: a caller who passes no `project`
    // must get an object with no `project` key at all, so nothing downstream can start depending
    // on a field that is absent in the common case.
    for (const entry of CONCIERGE_TOOL_CATALOG) {
      const before = evaluateToolPolicy(entry.name, { overrides: {} });
      expect(before, entry.name).not.toHaveProperty("project");
      expect(Object.keys(before).sort(), entry.name).toEqual(
        [
          "decision",
          "defaultDecision",
          "domain",
          "overridden",
          "reason",
          "requiresConfirmation",
          "riskClass",
          "source",
          "tool",
        ].sort(),
      );
    }
  });

  it("an OWN, unpinned repo with no project rules changes nothing", () => {
    // The other half of "additive": supplying a project context for a repo we own, with no rules,
    // must land on the identical decision/source/reason as supplying none. If this ever diverged,
    // wiring the binding up would silently re-tier every tool in the founder's own repo.
    for (const entry of CONCIERGE_TOOL_CATALOG) {
      const bare = evaluateToolPolicy(entry.name, { overrides: {} });
      const withProject = evaluateToolPolicy(entry.name, {
        overrides: {},
        project: projectPolicyContextFor("drodio/sparkle", ["drodio"], {}),
      });
      expect(withProject.decision, entry.name).toBe(bare.decision);
      expect(withProject.source, entry.name).toBe(bare.source);
      expect(withProject.reason, entry.name).toBe(bare.reason);
      expect(withProject.project?.tightened, entry.name).toBe(false);
    }
  });
});

describe("FAIL CLOSED — the direction every unknown resolves in", () => {
  it("an unresolvable slug is foreign, and floors mutates-main at ask", () => {
    const evaluation = evaluateToolPolicy("merge_pr", {
      overrides: { merge_pr: "allow" },
      project: projectPolicyContextFor(null, ["drodio"], {}),
    });
    expect(evaluation.decision).toBe("ask");
    expect(evaluation.source).toBe("foreign-repo");
    expect(evaluation.project?.foreign).toBe(true);
    expect(evaluation.project?.slug).toBeNull();
  });

  it("a malformed slug is foreign too — a bare name has no owner to check", () => {
    for (const bad of ["sparkle", "", "   ", "a/b/c", "/repo", "owner/"]) {
      const ctx = projectPolicyContextFor(bad, ["drodio", "owner", "a"], {});
      expect(ctx.slug, bad).toBeNull();
      expect(ctx.foreign, bad).toBe(true);
    }
  });

  it("a malformed project entry is ask-or-stricter, NEVER allow", () => {
    // The value is the interesting axis: whatever the human typed, the answer must not be the
    // global `allow` they set for every other project.
    for (const junk of ["Allow", "yes", "ALLOW", "allow ", "1", "denyish"]) {
      const evaluation = evaluateToolPolicy("spawn_build_agent", {
        overrides: { spawn_build_agent: "allow" },
        project: projectPolicyContextFor("drodio/sparkle", ["drodio"], {
          "drodio/sparkle": { spawn_build_agent: junk },
        }),
      });
      expect(evaluation.decision, junk).toBe("ask");
      expect(evaluation.source, junk).toBe("unreadable-project-override");
      expect(evaluation.project?.projectEntry, junk).toBe(junk);
    }
  });

  it("a non-string project entry contributes nothing rather than crashing", () => {
    const evaluation = evaluateToolPolicy("spawn_build_agent", {
      overrides: { spawn_build_agent: "allow" },
      project: projectPolicyContextFor("drodio/sparkle", ["drodio"], {
        "drodio/sparkle": { spawn_build_agent: undefined },
      }),
    });
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.project?.projectEntry).toBeNull();
  });
});

describe("the lattice, over base x pinned x foreign x project", () => {
  const rank = { allow: 0, ask: 1, deny: 2 } as const;
  const decisions = ["allow", "ask", "deny"] as const;

  it("POLICY_STRICTNESS orders the three and strictestDecision returns the maximum", () => {
    expect(POLICY_STRICTNESS).toEqual(rank);
    expect(strictestDecision()).toBe("allow");
    expect(strictestDecision("allow", "ask")).toBe("ask");
    expect(strictestDecision("deny", "allow")).toBe("deny");
    expect(strictestDecision("ask", "deny", "allow")).toBe("deny");
  });

  it("merge_pr (mutates-main) resolves to the strictest contributor, for every combination", () => {
    const cases = [
      { slug: "drodio/sparkle", pinnedFloor: "allow", foreignFloor: "allow" },
      { slug: "plow-pbc/tkmx-server", pinnedFloor: "deny", foreignFloor: "ask" },
      { slug: "someone-else/thing", pinnedFloor: "allow", foreignFloor: "ask" },
      { slug: null, pinnedFloor: "allow", foreignFloor: "ask" },
    ] as const;
    for (const c of cases) {
      for (const base of decisions) {
        for (const project of [...decisions, null]) {
          const evaluation = evaluateToolPolicy("merge_pr", {
            overrides: { merge_pr: base },
            project: projectPolicyContextFor(
              c.slug,
              ["drodio"],
              project === null || c.slug === null ? {} : { [c.slug]: { merge_pr: project } },
            ),
          });
          const contributors = [
            base,
            c.pinnedFloor,
            c.foreignFloor,
            c.slug === null || project === null ? "allow" : project,
          ] as const;
          const expected = contributors.reduce((a, b) => (rank[b] > rank[a] ? b : a));
          expect(evaluation.decision, `${c.slug}/${base}/${project}`).toBe(expected);
        }
      }
    }
  });

  it("a read-only tool is untouched by the pin and the foreign floor", () => {
    // The floors are scoped to `mutates-main` on purpose: a repo we do not own stays fully usable
    // and only the class that pushes into its main is gated. Without this, adopting the feature
    // would make every foreign project ask before it could so much as list its agents.
    const evaluation = evaluateToolPolicy("list_projects", {
      overrides: {},
      project: projectPolicyContextFor("plow-pbc/tkmx-server", ["drodio"], {}),
    });
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.project?.tightened).toBe(false);
  });
});

describe("ATTRIBUTION — the UI can only show what this returns", () => {
  it("produces each of the four new sources from some real input", () => {
    const produced = new Set<string>();
    produced.add(
      evaluateToolPolicy("merge_pr", {
        overrides: { merge_pr: "allow" },
        project: projectPolicyContextFor("drodio/sparkle", ["drodio"], {
          "drodio/sparkle": { merge_pr: "deny" },
        }),
      }).source,
    );
    produced.add(
      evaluateToolPolicy("merge_pr", {
        overrides: { merge_pr: "allow" },
        project: projectPolicyContextFor("drodio/sparkle", ["drodio"], {
          "drodio/sparkle": { merge_pr: "sometimes" },
        }),
      }).source,
    );
    produced.add(
      evaluateToolPolicy("merge_pr", {
        overrides: { merge_pr: "allow" },
        project: projectPolicyContextFor("someone-else/thing", ["drodio"], {}),
      }).source,
    );
    produced.add(
      evaluateToolPolicy("merge_pr", {
        overrides: { merge_pr: "allow" },
        project: projectPolicyContextFor("plow-pbc/tkmx-server", ["drodio"], {}),
      }).source,
    );
    expect([...produced].sort()).toEqual([
      "foreign-repo",
      "pinned-repo",
      "project-override",
      "unreadable-project-override",
    ]);
  });

  it("reports the INHERITED tier alongside the effective one", () => {
    // Requirement 3 of the brief: the UI must show which tier is in force AND where it came from.
    // "Denied for this repo, though you allowed it everywhere" needs both numbers in one object.
    const evaluation = evaluateToolPolicy("merge_pr", {
      overrides: { merge_pr: "allow" },
      project: projectPolicyContextFor("drodio/sparkle", ["drodio"], {
        "drodio/sparkle": { merge_pr: "ask" },
      }),
    });
    expect(evaluation.decision).toBe("ask");
    expect(evaluation.project).toEqual({
      slug: "drodio/sparkle",
      foreign: false,
      pinned: false,
      inheritedDecision: "allow",
      inheritedSource: "override",
      projectEntry: "ask",
      tightened: true,
    });
  });

  it("the reason strings name the lever the reader can actually pull", () => {
    const foreign = evaluateToolPolicy("merge_pr", {
      overrides: { merge_pr: "allow" },
      project: projectPolicyContextFor("someone-else/thing", ["drodio"], {}),
    });
    expect(foreign.reason).toContain("someone-else/thing");
    // The lever, named exactly as config.toml spells it — a remedy is an instruction people follow.
    expect(foreign.reason).toContain("[concierge].own_orgs");

    const pinned = evaluateToolPolicy("merge_pr", {
      overrides: { merge_pr: "allow" },
      project: projectPolicyContextFor("plow-pbc/tkmx-server", ["drodio"], {}),
    });
    expect(pinned.reason).toContain("plow-pbc/tkmx-server");
    expect(pinned.reason).toContain("own authority");
    expect(pinned.reason.toLowerCase()).toContain("human");
    // …and it must NOT send them to config, because a pin is the one thing config cannot loosen.
    expect(pinned.reason).not.toContain("own_orgs");
    expect(pinned.reason.toLowerCase()).not.toContain("config.toml");

    const project = evaluateToolPolicy("merge_pr", {
      overrides: { merge_pr: "allow" },
      project: projectPolicyContextFor("drodio/sparkle", ["drodio"], {
        "drodio/sparkle": { merge_pr: "deny" },
      }),
    });
    expect(project.reason).toContain("drodio/sparkle");
    expect(project.reason).toContain("Never"); // the project tier
    expect(project.reason).toContain("Allow"); // the inherited global tier
    expect(project.reason.toLowerCase()).toContain("only tighten");
  });

  it("does not claim a project decided something the global rule already had", () => {
    // `deny` globally and `deny` for the project: the answer is the same either way, so naming the
    // project override would send the human to delete a rule and watch nothing change.
    const evaluation = evaluateToolPolicy("merge_pr", {
      overrides: { merge_pr: "deny" },
      project: projectPolicyContextFor("drodio/sparkle", ["drodio"], {
        "drodio/sparkle": { merge_pr: "deny" },
      }),
    });
    expect(evaluation.source).toBe("override");
    expect(evaluation.project?.tightened).toBe(false);
  });
});

describe("slug helpers", () => {
  it("ownerOfSlug lowercases and rejects anything that is not owner/repo", () => {
    expect(ownerOfSlug("DROdio/Sparkle")).toBe("drodio");
    expect(ownerOfSlug("  drodio/sparkle  ")).toBe("drodio");
    expect(ownerOfSlug("sparkle")).toBeNull();
    expect(ownerOfSlug(null)).toBeNull();
  });

  it("isForeignSlug compares case-insensitively and treats null as foreign", () => {
    expect(isForeignSlug("DROdio/sparkle", ["drodio"])).toBe(false);
    expect(isForeignSlug("drodio/sparkle", ["DROdio"])).toBe(false);
    expect(isForeignSlug("drodio/sparkle", [])).toBe(true);
    expect(isForeignSlug(null, ["drodio"])).toBe(true);
  });

  it("isPinnedMergeProtectedSlug matches the shipped list case-insensitively", () => {
    for (const slug of MERGE_PROTECTED_SLUGS) {
      expect(isPinnedMergeProtectedSlug(slug.toUpperCase())).toBe(true);
    }
    expect(isPinnedMergeProtectedSlug("drodio/sparkle")).toBe(false);
    expect(isPinnedMergeProtectedSlug(null)).toBe(false);
  });

  it("conciergeToolConfigPath keeps its one-argument behaviour and quotes the slug", () => {
    expect(conciergeToolConfigPath("merge_pr")).toBe("concierge.tools.merge_pr");
    expect(conciergeToolConfigPath("merge_pr", null)).toBe("concierge.tools.merge_pr");
    // The quotes are load-bearing: the slug contains a `/`, which dotted-key syntax would
    // otherwise read as two more table levels.
    expect(conciergeToolConfigPath("merge_pr", "plow-pbc/tkmx-server")).toBe(
      'concierge.projects."plow-pbc/tkmx-server".tools.merge_pr',
    );
    expect(conciergeToolConfigPath("merge_pr", "DROdio/Sparkle")).toBe(
      'concierge.projects."drodio/sparkle".tools.merge_pr',
    );
  });
});
