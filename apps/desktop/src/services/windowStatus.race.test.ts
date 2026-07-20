/**
 * sparkle-csq2 — cross-window ghost alerts: the shared status blob loses writes.
 *
 * Each Tauri window is a SEPARATE WKWebView with its own JS thread sharing one origin's
 * localStorage. publishWindowRedAgents did a read-modify-write of the WHOLE map, and (1)->(2) is
 * not atomic ACROSS windows: window A can readMap() before B's write lands, then writeMap() a map
 * that predates B — dropping B's entry, or resurrecting an entry B just deleted. Nothing ever
 * corrects it (no heartbeat), so a ghost persists for the whole session, in both directions.
 *
 * These tests model that interleaving with a "stale reader" store: its READS return a snapshot
 * taken before the other window's write (the state A had already read), while its WRITES go
 * through to the real storage. That is exactly the lost-update window.
 *
 * The fix is structural: each window owns its OWN key, so a publish can never touch another
 * window's data and there is no read-modify-write to lose.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  emit: () => Promise.resolve(),
  listen: () => Promise.resolve(() => {}),
}));

import {
  publishWindowRedAgents,
  clearWindowStatus,
  resetWindowStatus,
  readOtherWindowsRedAgents,
} from "./windowStatus";
import { setWindowProject, type KV } from "./windowRegistry";

/** The shared origin storage, fully under test control (so a snapshot is exact, rather than relying
 *  on the environment's localStorage supporting key enumeration). */
let mem: Map<string, string>;
function memStore(): KV {
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
    // Real Storage enumerates; the prefix sweep depends on it.
    key: (i) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  };
}

/** A KV whose reads are frozen at construction — the state this window had ALREADY read — while its
 *  writes go through to the shared storage. Exactly the cross-webview read-modify-write window. */
function staleReader(): KV {
  const snapshot = new Map(mem);
  return {
    getItem: (k) => snapshot.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
  };
}

const red = (id: string) => [{ id, name: id.toUpperCase(), status: "waiting" as const }];

beforeEach(() => {
  mem = new Map();
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  setWindowProject("w-a", "pA", memStore());
  setWindowProject("w-b", "pB", memStore());
  setWindowProject("w-c", "pC", memStore());
});

describe("windowStatus — a publish must not clobber another window's entry (sparkle-csq2)", () => {
  it("keeps B's red agent when a stale A publishes after it", () => {
    // A has already read storage (nothing red yet)...
    const stale = staleReader();
    // ...then B goes red and publishes...
    publishWindowRedAgents("w-b", "pB", "B", red("b1"), memStore());
    // ...and only now does A write, from its pre-B view.
    publishWindowRedAgents("w-a", "pA", "A", red("a1"), stale);

    // A third window must see BOTH. Under the shared-blob read-modify-write, B's entry was
    // overwritten out of existence here.
    const seen = readOtherWindowsRedAgents("w-c", memStore()).map((a) => a.agentId).sort();
    expect(seen).toEqual(["a1", "b1"]);
  });

  it("does not resurrect an entry another window just cleared (the ghost alert)", () => {
    // B is red, then goes green and clears itself.
    publishWindowRedAgents("w-b", "pB", "B", red("b1"), memStore());
    const stale = staleReader(); // A's read still contains B's red entry
    clearWindowStatus("w-b", memStore());

    // A now publishes its own status from that stale view — it must not write B's deleted entry back.
    publishWindowRedAgents("w-a", "pA", "A", red("a1"), stale);

    const seen = readOtherWindowsRedAgents("w-c", memStore()).map((a) => a.agentId);
    expect(seen).toEqual(["a1"]); // b1 stays gone — no ghost
  });

  it("a window clearing itself never disturbs another window's entry", () => {
    publishWindowRedAgents("w-a", "pA", "A", red("a1"), memStore());
    const stale = staleReader(); // A's view predates B going red
    publishWindowRedAgents("w-b", "pB", "B", red("b1"), memStore());

    clearWindowStatus("w-a", stale);

    expect(readOtherWindowsRedAgents("w-c", memStore()).map((a) => a.agentId)).toEqual(["b1"]);
  });
});

// roborev follow-ups: both of these lock CONTRACTS that were previously only implied by comments.
describe("windowStatus — registry coupling and cold-start sweep contracts", () => {
  it("suppresses a red entry published by a label that is NOT registered open", () => {
    // Readers gate on the windowRegistry. This is NOT new in the per-window-key change — the old
    // reader already did `if (!isWindowOpen(label)) continue` — but nothing pinned it, so a future
    // registry-timing regression could silently suppress REAL alerts (the inverse of the ghost bug).
    // The contract is: publish always follows registration.
    publishWindowRedAgents("w-ghost", "pG", "G", red("g1"), memStore());

    expect(readOtherWindowsRedAgents("w-c", memStore())).toEqual([]);

    // ...and it becomes visible the moment the window registers.
    setWindowProject("w-ghost", "pG", memStore());
    expect(readOtherWindowsRedAgents("w-c", memStore()).map((a) => a.agentId)).toEqual(["g1"]);
  });

  it("cold-start sweep clears crash-orphaned keys even with an EMPTY registry", () => {
    // The whole point of sweeping by prefix: a hard crash can leave the registry empty while status
    // keys survive. Keying the wipe off registered labels would orphan exactly those ghosts.
    publishWindowRedAgents("w-a", "pA", "A", red("a1"), memStore());
    publishWindowRedAgents("w-b", "pB", "B", red("b1"), memStore());
    mem.delete("sparkle-window-projects"); // registry lost in the crash

    resetWindowStatus(memStore());

    expect([...mem.keys()].filter((k) => k.startsWith("sparkle-window-status"))).toEqual([]);
  });

  it("documents the reduced guarantee when the KV cannot enumerate", () => {
    // Fallback branch: with no key()/length the sweep can only consult the registry, so a
    // crash-orphaned key (label no longer registered) SURVIVES. Best-effort by construction —
    // asserted so the weaker guarantee is explicit rather than assumed.
    publishWindowRedAgents("w-a", "pA", "A", red("a1"), memStore());
    const noEnum: KV = {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
    };
    mem.delete("sparkle-window-projects"); // registry lost → nothing to enumerate from

    resetWindowStatus(noEnum);

    expect(mem.has("sparkle-window-status:w-a")).toBe(true); // survives — known limitation
  });
});
