import { describe, expect, it } from "vitest";
import { migratePersisted } from "./projectStore";

type HealedAgent = {
  id: string;
  name: string;
  kind?: string;
  namePinned: boolean;
  selfNamed?: boolean;
  pinnedIndex: number | null;
};

/** Read back a single agent from the migrated shape. */
function agentsOf(out: unknown): HealedAgent[] {
  return (out as { projects: { agents: HealedAgent[] }[] }).projects[0]!.agents;
}

describe("migratePersisted — v9 stale self-name pin heal (sparkle-pel7 residue)", () => {
  // The pre-fix rename_agent op routed through renameAgent() and pinned every self-named row
  // (namePinned:true) while leaving pinnedIndex null. Pel7 stopped NEW bad pins but nothing healed
  // the ones already frozen in localStorage. v9 heals exactly that fingerprint — keep the name,
  // drop the erroneous pin, and mark selfNamed so the name is authoritative but the row is free.
  const staleFingerprint = () => ({
    projects: [
      {
        id: "p1",
        agents: [
          // (1) stale self-name pin on a build agent — the bug. Heal it.
          { id: "build-stale", name: "Stripe Checkout Button", kind: "build", namePinned: true, selfNamed: false, pinnedIndex: null },
          // (2) same fingerprint on a worker — heal it.
          { id: "worker-stale", name: "Auto-Approve Builder", kind: "worker", namePinned: true, pinnedIndex: null },
          // (3) a real drag/manual pin (pinnedIndex set) — deliberate, leave it.
          { id: "manual-pin", name: "My Pinned Row", kind: "build", namePinned: true, selfNamed: false, pinnedIndex: 3 },
          // (4) a think agent pinned to its epic title (pinnedIndex null) — legit, leave it.
          { id: "think-epic", name: "Ship the pin fix", kind: "think", namePinned: true, selfNamed: false, pinnedIndex: null },
          // (5) a shell "run as command" tab, name-pinned by design (addAgent opts.name) — leave it.
          { id: "shell-cmd", name: "npm test", kind: "shell", namePinned: true, selfNamed: false, pinnedIndex: null },
          // (6) an already-correct self-named agent — no pin, nothing to do.
          { id: "self-ok", name: "Prospect Radar MVP", kind: "build", namePinned: false, selfNamed: true, pinnedIndex: null },
          // (7) a plain auto-named agent — untouched.
          { id: "auto", name: "Build 1", kind: "build", namePinned: false, selfNamed: false, pinnedIndex: null },
        ],
      },
    ],
  });

  it("heals stale build/worker self-name pins: keeps the name, unpins, marks selfNamed", () => {
    const a = agentsOf(migratePersisted(staleFingerprint(), 8));
    const buildStale = a.find((x) => x.id === "build-stale")!;
    expect(buildStale.namePinned).toBe(false);
    expect(buildStale.selfNamed).toBe(true);
    expect(buildStale.name).toBe("Stripe Checkout Button"); // name preserved
    expect(buildStale.pinnedIndex).toBeNull();

    const workerStale = a.find((x) => x.id === "worker-stale")!;
    expect(workerStale.namePinned).toBe(false);
    expect(workerStale.selfNamed).toBe(true);
    expect(workerStale.name).toBe("Auto-Approve Builder");
  });

  it("leaves deliberate pins and correct records untouched", () => {
    const a = agentsOf(migratePersisted(staleFingerprint(), 8));
    // (3) real manual/drag pin keeps its anchor + pin
    expect(a.find((x) => x.id === "manual-pin")!.namePinned).toBe(true);
    expect(a.find((x) => x.id === "manual-pin")!.pinnedIndex).toBe(3);
    // (4) think-epic pin preserved
    expect(a.find((x) => x.id === "think-epic")!.namePinned).toBe(true);
    // (5) shell command pin preserved
    expect(a.find((x) => x.id === "shell-cmd")!.namePinned).toBe(true);
    // (6) already self-named agent unchanged
    const selfOk = a.find((x) => x.id === "self-ok")!;
    expect(selfOk.namePinned).toBe(false);
    expect(selfOk.selfNamed).toBe(true);
    // (7) auto-named agent unchanged
    expect(a.find((x) => x.id === "auto")!.namePinned).toBe(false);
  });

  it("ambiguous pre-unified-pin manual rename: folded into selfNamed (documented trade-off)", () => {
    // Before bbea8ac4 (2026-06-27), a MANUAL sidebar rename of a build/worker agent called
    // renameAgent() without an index, producing the IDENTICAL fingerprint as the pel7 residue
    // (namePinned:true, pinnedIndex:null, !selfNamed, build/worker). The migration cannot tell them
    // apart, so it heals this record too: the NAME is preserved and stays frozen against auto-naming
    // (via selfNamed), only the pin chip is dropped. The single behavioral divergence — resetAutoName
    // clearing a selfNamed (not namePinned) name on genuine slot reuse — is exercised by the
    // projectStore resetAutoName tests; here we just lock the migration's intended output shape.
    const persisted = {
      projects: [
        {
          id: "p1",
          agents: [
            { id: "manual-legacy", name: "Payments Refactor", kind: "build", namePinned: true, selfNamed: false, pinnedIndex: null },
          ],
        },
      ],
    };
    const a = agentsOf(migratePersisted(persisted, 8));
    const rec = a.find((x) => x.id === "manual-legacy")!;
    expect(rec.name).toBe("Payments Refactor"); // name is NEVER dropped by the migration itself
    expect(rec.namePinned).toBe(false); // pin chip cleared
    expect(rec.selfNamed).toBe(true); // still frozen against auto-naming
  });

  it("does not re-run once the store is already at v9", () => {
    // A store persisted at v9 could legitimately have a fresh manual pin with pinnedIndex null
    // (e.g. a rename that predates a reorder) — the heal must not touch it on a later rehydrate.
    const persisted = {
      projects: [
        {
          id: "p1",
          agents: [
            { id: "fresh-pin", name: "Kept", kind: "build", namePinned: true, selfNamed: false, pinnedIndex: null },
          ],
        },
      ],
    };
    const a = agentsOf(migratePersisted(persisted, 9));
    expect(a.find((x) => x.id === "fresh-pin")!.namePinned).toBe(true);
  });
});

describe("migratePersisted — v8 pinnedIndex backfill", () => {
  it("backfills pinnedIndex: null without touching namePinned", () => {
    const persisted = {
      projects: [
        {
          id: "p1",
          agents: [
            { id: "a1", namePinned: true },
            { id: "a2", namePinned: false },
          ],
        },
      ],
    };
    const out = migratePersisted(persisted, 7) as {
      projects: { agents: { id: string; namePinned: boolean; pinnedIndex: number | null }[] }[];
    };
    const agents = out.projects[0]!.agents;
    const a1 = agents.find((a) => a.id === "a1")!;
    const a2 = agents.find((a) => a.id === "a2")!;
    expect(a1.pinnedIndex).toBeNull();
    expect(a2.pinnedIndex).toBeNull();
    expect(a1.namePinned).toBe(true); // unchanged — nothing freezes on upgrade
    expect(a2.namePinned).toBe(false);
  });
});

describe("migratePersisted — v10 promptHistory source backfill (picker-tagging)", () => {
  type WithHistory = {
    projects: { agents: { id: string; promptHistory: { id: string; source?: string }[] }[] }[];
  };

  it("backfills source:'composer' on every legacy promptHistory entry", () => {
    const persisted = {
      projects: [
        {
          id: "p1",
          agents: [
            { id: "a1", promptHistory: [{ id: "h0", text: "x", at: 0 }, { id: "h1", text: "y", at: 1 }] },
            { id: "a2", promptHistory: [] },
          ],
        },
      ],
    };
    const out = migratePersisted(persisted, 9) as WithHistory;
    const a1 = out.projects[0]!.agents.find((a) => a.id === "a1")!;
    expect(a1.promptHistory.map((e) => e.source)).toEqual(["composer", "composer"]);
    // Empty history is fine — nothing to backfill, no throw.
    expect(out.projects[0]!.agents.find((a) => a.id === "a2")!.promptHistory).toEqual([]);
  });

  it("does not overwrite an already-tagged picker entry", () => {
    const persisted = {
      projects: [
        {
          id: "p1",
          agents: [
            {
              id: "a1",
              promptHistory: [
                { id: "h0", text: "real", at: 0, source: "composer" },
                { id: "h1", text: "1", at: 1, source: "picker" },
              ],
            },
          ],
        },
      ],
    };
    const out = migratePersisted(persisted, 9) as WithHistory;
    expect(out.projects[0]!.agents[0]!.promptHistory.map((e) => e.source)).toEqual([
      "composer",
      "picker",
    ]);
  });
});
