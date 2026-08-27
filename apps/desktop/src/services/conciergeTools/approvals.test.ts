// The approvals domain: what the concierge can see about its OWN pending requests, and — the part
// that matters most — what it deliberately cannot do.
//
// Driven through the REAL store rather than a mock. The behaviour under test is mostly the store's
// TTL/spent semantics as seen through this module's view, and a mock would let the view drift from
// the rules the confirmation UI actually enforces.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  useConciergeApprovals,
  clearConciergeApprovals,
  APPROVAL_REQUEST_TTL_MS,
  type ConciergeApproval,
} from "../../stores/conciergeApprovals";
import { APPROVALS_OPS, APPROVALS_RISK, listPendingApprovals, getApproval } from "./approvals";

const NOW = 1_000_000;

/** The caller every fixture below belongs to. Named rather than inlined because these two ops now
 *  take a caller identity, and a bare string at each call site reads as noise rather than as the
 *  thing being matched. The CROSS-caller cases — one agent's prompt must not reach another's
 *  transcript — live in `approvalRouting.test.ts`, which drives the real dispatch with both
 *  agents mounted rather than seeding the store directly (bead `sparkle-tavx1`). */
const CALLER = "agent-a";

// ---------------------------------------------------------------------------------------------
// Import-shape helpers for the self-approval guard at the bottom of this file
// ---------------------------------------------------------------------------------------------

/** The only bindings this module may take from the approvals store. Everything else — every
 *  mutator, and the store handle itself — is absent BY DESIGN. See the guard for why. */
const ALLOWED_STORE_IMPORTS = [
  "pendingApprovals",
  "findApproval",
  // The one test every agent-facing read applies — a pure predicate over an entry, with no way to
  // change one. Allowed for the same reason `pendingApprovals` is: it reads, it cannot approve.
  "approvalBelongsTo",
  "ConciergeApproval",
  "ApprovalOutcome",
  "ApprovalArgLine",
];

/**
 * The clause of each import statement that pulls from the approvals store.
 *
 * Matched ONE STATEMENT AT A TIME. An earlier version used a single lazy `import ([\s\S]*?) from
 * "…conciergeApprovals"`, which anchors on the FIRST `import` token in the file and therefore
 * spans every statement above the one it was aiming at. It passed only because this module happens
 * to have a single import; adding any import above it would have made the clause swallow both and
 * failed the guard with a message about self-approval rather than about the new import.
 *
 * The specifier also tolerates an extension (`…/conciergeApprovals.js`), which the previous
 * end-anchored pattern skipped silently — i.e. it would not have inspected the import at all.
 */
function storeImportClauses(source: string): string[] {
  return [...source.matchAll(/^import\b([\s\S]*?)from\s+"([^"]+)";/gm)]
    .filter((m) => /conciergeApprovals(\.\w+)?$/.test(m[2] ?? ""))
    .map((m) => m[1] ?? "");
}

/** The identifiers a clause binds — pre-alias, with the keywords that are not bindings dropped so a
 *  genuine failure names the offending import rather than `import`/`from`/`type`. */
function importedNames(clause: string): string[] {
  return [...clause.matchAll(/([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?/g)]
    .map((m) => m[1]!)
    .filter((n) => n !== "type" && n !== "import" && n !== "from");
}

function approval(id: string, over: Partial<ConciergeApproval> = {}): ConciergeApproval {
  return {
    id,
    requestedBy: CALLER,
    domain: "workflow",
    op: "merge_pr",
    summary: "Merge a pull request",
    riskClass: "irreversible",
    riskNote: "This lands code on main.",
    args: [{ key: "number", value: "753" }],
    // The unredacted value the fingerprint was computed from. Present on the store entry so a
    // replay is byte-identical to the call the human read — and deliberately NOT surfaced by
    // ApprovalView, which carries the same redacted `args` lines the human was shown.
    rawArgs: { number: 753 },
    configPath: "concierge.tools.merge_pr",
    fingerprint: `fp-${id}`,
    requestedAt: NOW,
    expiresAt: NOW + APPROVAL_REQUEST_TTL_MS,
    outcome: "pending",
    resolvedAt: null,
    spent: false,
    ...over,
  };
}

function seed(...entries: ConciergeApproval[]): void {
  useConciergeApprovals.getState().replace(entries);
}

beforeEach(() => clearConciergeApprovals());

describe("classification", () => {
  it("is read-only throughout", () => {
    for (const op of APPROVALS_OPS) expect(APPROVALS_RISK[op]).toBe("read-only");
  });
});

describe("list_pending_approvals", () => {
  it("returns what is waiting on the human, with the prose the card shows them", () => {
    seed(approval("a"));

    const r = listPendingApprovals(CALLER, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({
      id: "a",
      domain: "workflow",
      op: "merge_pr",
      outcome: "pending",
      summary: "Merge a pull request",
      configPath: "concierge.tools.merge_pr",
      awaitingHuman: true,
    });
    // The redacted arg LINES, never the raw argument object — the same rendering the human sees.
    expect(r.data[0]!.args).toEqual([{ key: "number", value: "753" }]);
  });

  it("omits requests whose window closed, rather than reporting them as still pending", () => {
    seed(approval("stale"));

    const before = listPendingApprovals(CALLER, NOW);
    expect(before.ok && before.data).toHaveLength(1);
    const after = listPendingApprovals(CALLER, NOW + APPROVAL_REQUEST_TTL_MS + 1);
    expect(after.ok && after.data).toEqual([]);
  });

  it("omits an approval that has already been spent", () => {
    seed(approval("used", { outcome: "approved", spent: true, resolvedAt: NOW }));

    const r = listPendingApprovals(CALLER, NOW);
    expect(r.ok && r.data).toEqual([]);
  });
});

describe("get_approval", () => {
  // The whole point of section D: the concierge finds out the answer itself instead of waiting to
  // be told in words.
  it("reads a RESOLVED approval, so the outcome is observable without asking the human", () => {
    seed(approval("done", { outcome: "approved", resolvedAt: NOW + 5 }));

    const r = getApproval("done", CALLER, NOW + 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.outcome).toBe("approved");
    expect(r.data.resolvedAt).toBe(NOW + 5);
    expect(r.data.awaitingHuman).toBe(false);
  });

  it("distinguishes an approved-but-spent grant from a fresh one", () => {
    seed(approval("spent", { outcome: "approved", spent: true, resolvedAt: NOW }));

    const r = getApproval("spent", CALLER, NOW);
    // approved AND spent — single-use, so this is not permission to run it again.
    expect(r.ok && [r.data.outcome, r.data.spent]).toEqual(["approved", true]);
  });

  it("refuses an id it does not hold rather than returning an empty success", () => {
    const r = getApproval("ghost", CALLER, NOW);
    expect(r.ok).toBe(false);
    // "I can't find it" and "they said no" must not read the same to a model deciding to retry.
    if (!r.ok) expect(r.reason).toBe("unknown-approval");
  });

  it("reports a denial as a denial", () => {
    seed(approval("no", { outcome: "denied", resolvedAt: NOW + 1 }));
    const r = getApproval("no", CALLER, NOW + 2);
    expect(r.ok && r.data.outcome).toBe("denied");
  });
});

describe("the concierge cannot approve its own requests", () => {
  // A concierge that can grant its own ask-tier calls has no ask tier — it just LOOKS gated, which
  // is worse than having no tier at all. Enforced structurally: this module must not even import
  // the store's mutators. (mcp-control's conciergeOps.test.ts asserts the same from the other side,
  // so the property survives someone deleting one of the two.)
  it("exposes no approve/deny op", () => {
    expect(APPROVALS_OPS).toEqual(["list_pending_approvals", "get_approval"]);
  });

  // Checked against WHAT THE MODULE PULLS IN FROM THE STORE, allowlist-style.
  //
  // An earlier version of this test listed banned names and asserted `not.toContain` over
  // comma-split import fragments. That was bypassable in four ways and so proved almost nothing:
  // `import * as s from "…"` was invisible to it, an alias made the fragment
  // "approveApproval as grant" (which `not.toContain` passes), and the whole check was defeated by
  // reaching the store directly via `useConciergeApprovals.getState()`. An allowlist has none of
  // those holes: anything new — aliased, namespaced, or renamed — fails until it is named here
  // deliberately.
  it("imports only READ helpers from the approvals store, and never the store handle itself", () => {
    const source = readFileSync(fileURLToPath(new URL("./approvals.ts", import.meta.url)), "utf8");

    const storeImports = storeImportClauses(source);
    expect(storeImports.length).toBeGreaterThan(0); // the extractor must have found something

    for (const clause of storeImports) {
      // A namespace import would make every mutator reachable under one binding.
      expect(clause).not.toMatch(/\*\s+as\s+/);
      for (const name of importedNames(clause)) expect(ALLOWED_STORE_IMPORTS).toContain(name);
    }

    // …and no back door around the imports to the store handle itself.
    expect(source).not.toMatch(/useConciergeApprovals/);
    // …nor a dynamic one, which no static import check would see.
    expect(source).not.toMatch(/require\(|import\s*\(/);
  });
});
