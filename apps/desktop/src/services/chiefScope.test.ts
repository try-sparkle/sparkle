import { describe, it, expect } from "vitest";
import {
  resolveChiefProject,
  checkChiefTool,
  CHIEF_DESTRUCTIVE_TOOLS,
  type ChiefCaller,
  type ChiefProject,
} from "./chiefScope";

// A catalog small enough to read but with the two traps in it: a duplicate NAME across two ids, and
// a project nobody is scoped to.
const CATALOG: ChiefProject[] = [
  { project_id: "project_p1", name: "Founder Festival" },
  { project_id: "project_p2", name: "Scoring Rubric" },
  { project_id: "project_p3", name: "US Department of State" },
  { project_id: "project_dupA", name: "Shared Name" },
  { project_id: "project_dupB", name: "Shared Name" },
];

const concierge: ChiefCaller = { kind: "concierge", allowed: "all", primary: null };
const agentBoundP1: ChiefCaller = {
  kind: "agent",
  agentId: "a1",
  allowed: ["project_p1"],
  primary: "project_p1",
  sparkleProjectName: "sparkle",
};
const agentUnbound: ChiefCaller = {
  kind: "agent",
  agentId: "a2",
  allowed: [],
  primary: null,
  sparkleProjectName: "unbound-proj",
};

describe("resolveChiefProject — scope enforcement", () => {
  // THE PAIR (bead sparkle-rvf6n): a refusal alone is ambiguous — it could come from any earlier
  // guard. These two run the SAME caller through the SAME function and differ only in the project
  // asked for, which pins the refusal to the scope rule and nothing else.
  it("REFUSES an agent asking for a project outside its scope", () => {
    const d = resolveChiefProject(agentBoundP1, "project_p3", CATALOG);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toBe("out_of_scope");
    // The message must say what this caller MAY reach — a bare "denied" sends the agent guessing.
    // It must NOT name the project it asked for by id; this assertion used to require exactly that
    // and so pinned the id→name oracle as the contract (roborev 63043), which is what made the leak
    // a test change rather than a code change. The dedicated cases at the bottom of this file cover
    // both directions.
    expect(d.message).toContain("Founder Festival");
    expect(d.message).toContain("No Chief call was made");
  });

  it("ALLOWS that same agent asking for the project it IS scoped to", () => {
    const d = resolveChiefProject(agentBoundP1, "project_p1", CATALOG);
    expect(d).toEqual({
      ok: true,
      projectId: "project_p1",
      projectName: "Founder Festival",
      source: "requested",
    });
  });

  it("lets the concierge reach a project no agent is scoped to", () => {
    const d = resolveChiefProject(concierge, "project_p3", CATALOG);
    expect(d.ok && d.projectId).toBe("project_p3");
  });

  it("resolves by NAME as well as id, case-insensitively", () => {
    const d = resolveChiefProject(concierge, "  founder festival ", CATALOG);
    expect(d.ok && d.projectId).toBe("project_p1");
  });

  it("REFUSES a name matching two projects rather than picking the first", () => {
    const d = resolveChiefProject(concierge, "Shared Name", CATALOG);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toBe("ambiguous_name");
    expect(d.message).toContain("project_dupA");
    expect(d.message).toContain("project_dupB");
  });

  it("REFUSES an unknown project rather than falling back to a default", () => {
    const withPrimary = { ...concierge, primary: "project_p1" };
    const d = resolveChiefProject(withPrimary, "project_nope", CATALOG);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toBe("unknown_project");
  });
});

describe("resolveChiefProject — defaulting", () => {
  it("uses the bound primary when the caller names no project", () => {
    const d = resolveChiefProject(agentBoundP1, undefined, CATALOG);
    expect(d).toEqual({
      ok: true,
      projectId: "project_p1",
      projectName: "Founder Festival",
      source: "primary",
    });
  });

  it("REFUSES an unbound agent that names no project (never picks one of 348)", () => {
    const d = resolveChiefProject(agentUnbound, undefined, CATALOG);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toBe("unbound");
  });

  it("REFUSES an unbound agent that names a real project", () => {
    const d = resolveChiefProject(agentUnbound, "project_p1", CATALOG);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toBe("unbound");
  });

  it("tells the concierge to ASK when nothing is bound or named", () => {
    const d = resolveChiefProject(concierge, undefined, CATALOG);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toBe("ambiguous");
    expect(d.message).toContain("ASK the human");
  });

  it("REFUSES a primary that is not in the allowed set (inconsistent binding)", () => {
    const broken: ChiefCaller = {
      kind: "agent",
      agentId: "a3",
      allowed: ["project_p1"],
      primary: "project_p3",
    };
    const d = resolveChiefProject(broken, undefined, CATALOG);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toBe("out_of_scope");
  });
});

describe("checkChiefTool — destructive verbs", () => {
  it("REFUSES a destructive tool for a build agent", () => {
    const r = checkChiefTool(agentBoundP1, "delete_asset");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("destructive_denied");
  });

  it("ALLOWS the same agent a non-destructive tool (the pair)", () => {
    expect(checkChiefTool(agentBoundP1, "list_assets")).toEqual({ ok: true });
  });

  it("ALLOWS the concierge a destructive tool", () => {
    expect(checkChiefTool(concierge, "delete_asset")).toEqual({ ok: true });
  });

  it("refuses EVERY name on the denylist for an agent", () => {
    // The loop below iterates the denylist, so an EMPTY denylist would satisfy it vacuously —
    // zero iterations, zero assertions, green. A `size >= 10` floor with 13 entries was the first
    // repair and it was not enough (roborev 63038): it tolerates deleting ANY THREE names, and the
    // spot-check covered only three of them, so dropping `delete_memory`/`delete_session`/
    // `delete_share_link` left this suite fully green while those verbs opened to every build
    // agent. Pin the membership EXACTLY, as a ratchet: a removal or a rename now goes red and
    // forces a deliberate edit on both sides.
    expect([...CHIEF_DESTRUCTIVE_TOOLS].sort()).toEqual(
      [
        "create_project_invitation",
        "create_share_link",
        "delete_action",
        "delete_asset",
        "delete_chat",
        "delete_label",
        "delete_memory",
        "delete_message",
        "delete_project_invitation",
        "delete_session",
        "delete_share_link",
        "delete_skill",
        "remove_chat_member",
        "update_project",
      ].sort(),
    );
    for (const name of CHIEF_DESTRUCTIVE_TOOLS) {
      expect(checkChiefTool(agentBoundP1, name).ok, name).toBe(false);
    }
  });

  // ── THE GATE FAILS CLOSED NOW (roborev 63036, 63043) ──────────────────────────────────────────
  // A 13-name exact-string denylist over a 58-tool surface permits everything nobody enumerated,
  // and `chief_call` hands a build agent an arbitrary verb string to try. These are the two ways
  // through that the name list alone could not stop.
  it("refuses a destructive verb that is NOT on the list, by its shape", () => {
    // Every one of these was reachable by any build agent: the set's own doc-comment claims to
    // cover tools that "DESTROY or mutate shared configuration", and these mutate.
    for (const name of [
      "update_memory",
      "update_asset",
      "update_chat",
      "update_skill",
      "update_label",
      "remove_project_member",
      "revoke_api_key",
      "archive_chat",
      "delete_something_chief_ships_next_year",
    ]) {
      expect(CHIEF_DESTRUCTIVE_TOOLS.has(name), `${name} is not on the list`).toBe(false);
      expect(checkChiefTool(agentBoundP1, name).ok, name).toBe(false);
    }
  });

  it("refuses a listed verb re-spelled to dodge the comparison", () => {
    // The gate used to compare RAW while the policy layer normalized, so each of these walked
    // straight through the access-control check.
    for (const name of [
      "Delete_Asset",
      "DELETE_ASSET",
      "  delete_asset  ",
      "mcp__chief__delete_asset",
      "MCP__CHIEF__delete_asset",
    ]) {
      expect(checkChiefTool(agentBoundP1, name).ok, name).toBe(false);
    }
  });

  it("…and still does NOT over-reach onto the verbs an agent is here to use (the pair)", () => {
    // The counterweight, and it is what makes the two cases above mean something: a gate that
    // refused everything would satisfy them exactly as well. `create_*` is deliberately not a
    // structural prefix — creating a chat, a memory or an upload is the ordinary work.
    for (const name of [
      "create_chat",
      "create_memory",
      "send_message",
      "upload_file",
      "list_assets",
      "get_asset",
      "list_chats",
      "mcp__chief__list_chats",
    ]) {
      expect(checkChiefTool(agentBoundP1, name).ok, name).toBe(true);
    }
  });

  it("keeps BOTH dangerous create_ verbs refused, which is what the name floor is FOR", () => {
    // These grant OUTSIDE access rather than writing content, so no prefix rule catches them and
    // the explicit list is the only thing that does. Deleting either from the set must not be
    // covered by the structural rule.
    //
    // THE TITLE SAID "TWO" AND THE BODY CHECKED ONE (roborev 63136). `create_share_link` was named
    // in the source's design note as staying on the list, was absent from the list, and was missing
    // from both this case and the membership ratchet — so a build agent could mint a public link to
    // a real client's project, and a concierge with `chief_call = "allow"` could do it with no
    // approval card. A test whose title claims more coverage than its assertions is worse than a
    // missing test: it reads as the guard.
    for (const verb of ["create_project_invitation", "create_share_link"]) {
      expect(checkChiefTool(agentBoundP1, verb), verb).toMatchObject({ ok: false });
      expect(checkChiefTool(agentBoundP1, `mcp__chief__${verb}`), verb).toMatchObject({ ok: false });
    }
  });

  it("permits the write tools build agents are meant to have", () => {
    for (const name of ["create_chat", "send_message", "upload_file", "create_memory"]) {
      expect(checkChiefTool(agentBoundP1, name).ok, name).toBe(true);
    }
  });
});

// ── THE REFUSAL ITSELF MUST NOT LEAK, AND ITS REMEDY MUST BE SAFE TO FOLLOW ──────────────────────
// Two findings that are the same mistake in two places (roborev 63036, 63043): a refusal written for
// the concierge, then served to a scoped build agent under conditions where following it succeeds.
// AGENTS.md's "User-facing copy is code" section is about exactly this class.
describe("resolveChiefProject — what a refusal is allowed to say", () => {
  it("does NOT tell a scoped agent to enumerate the catalog", () => {
    const d = resolveChiefProject(agentBoundP1, "no-such-project", CATALOG);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    // The remedy used to be "Call `chief_list_projects` to see what this token can reach" — and
    // `checkChiefTool` does not deny `list_projects`, so an agent following it would successfully
    // list all 348 projects, most of them other clients' work.
    expect(d.message).not.toContain("chief_list_projects");
    // It is told its own bound set instead, which is the answer it actually needs.
    expect(d.message).toContain("Founder Festival");
    // …and nothing about the projects it may not reach.
    expect(d.message).not.toContain("US Department of State");
    expect(d.message).not.toContain("Scoring Rubric");
  });

  it("…but DOES tell the concierge, which reaches everything anyway (the pair)", () => {
    // Same function, same missing project — only the caller differs. Without this, the case above
    // is satisfied by a remedy that says nothing useful to anyone.
    const d = resolveChiefProject(concierge, "no-such-project", CATALOG);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.message).toContain("chief_list_projects");
  });

  it("does not echo the NAME of a project the caller asked for by id and may not reach", () => {
    // The id→name oracle. Existence is checked before scope, so a fake id answers `unknown_project`
    // and a REAL one answers `out_of_scope` — quoting its name. An agent could enumerate the whole
    // account by probing ids and reading which refusal came back.
    const d = resolveChiefProject(agentBoundP1, "project_p3", CATALOG);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toBe("out_of_scope");
    expect(d.message).not.toContain("US Department of State");
    expect(d.message).not.toContain("project_p3");
    // It still says what it CAN reach, so the refusal remains actionable.
    expect(d.message).toContain("Founder Festival");
    expect(d.message).toContain("No Chief call was made");
  });

  it("DOES echo a name the caller supplied itself (the pair) — that reveals nothing", () => {
    // Asking by name means the caller already holds the name, so quoting it back leaks nothing.
    // Without this pair the case above is satisfied by stripping every name from every message,
    // which would make an out-of-scope refusal unreadable.
    const d = resolveChiefProject(agentBoundP1, "US Department of State", CATALOG);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toBe("out_of_scope");
    expect(d.message).toContain("US Department of State");
  });
});

// ── A BINDING THAT NO LONGER RESOLVES IS A REFUSAL, NOT A HALF-ANSWER (roborev 63036) ────────────
describe("resolveChiefProject — the default path checks the catalog too", () => {
  it("REFUSES when the bound primary is not in the catalog", () => {
    // A Chief project deleted upstream, or one the token stopped seeing after a credential
    // rotation. This used to resolve `{ ok: true }` with `projectName` falling back to the raw id,
    // so the call proceeded and failed opaquely at Chief while any UI printed `project_gone` as a
    // project name — the one outcome this module's design rule forbids.
    const stale: ChiefCaller = {
      kind: "agent",
      agentId: "a3",
      allowed: ["project_gone"],
      primary: "project_gone",
      sparkleProjectName: "sparkle",
    };
    const d = resolveChiefProject(stale, undefined, CATALOG);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toBe("unknown_project");
    expect(d.message).toContain("re-bind");
    expect(d.message).toContain("No Chief call was made");
  });

  it("says DEGRADED, not deleted, when the catalog came back empty", () => {
    // The two refusals must stay distinguishable (roborev 63136). The catalog is one list_projects
    // call whose rows are parsed out of structuredContent, so a shape change or a paged response
    // yields zero rows — and a refusal that asserts "it was deleted upstream, re-bind" would send
    // the human to un-break a binding that is perfectly fine, on every default-path call.
    const live: ChiefCaller = {
      kind: "agent",
      agentId: "a4",
      allowed: ["project_p1"],
      primary: "project_p1",
      sparkleProjectName: "sparkle",
    };
    const d = resolveChiefProject(live, undefined, []);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toBe("ambiguous");
    expect(d.message).toContain("EMPTY");
    // The distinguishing property: it must NOT blame the binding.
    expect(d.message).not.toContain("re-bind");
    expect(d.message).toContain("degraded");
  });

  it("RESOLVES when that same primary IS in the catalog (the pair)", () => {
    // Same caller shape, same call, differing only in whether the catalog contains the binding —
    // so the refusal above is pinned to the catalog check and not to some earlier guard.
    const live: ChiefCaller = {
      kind: "agent",
      agentId: "a3",
      allowed: ["project_p1"],
      primary: "project_p1",
      sparkleProjectName: "sparkle",
    };
    expect(resolveChiefProject(live, undefined, CATALOG)).toEqual({
      ok: true,
      projectId: "project_p1",
      projectName: "Founder Festival",
      source: "primary",
    });
  });
});
