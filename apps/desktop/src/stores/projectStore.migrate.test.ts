import { describe, expect, it } from "vitest";
import { migratePersisted } from "./projectStore";

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
