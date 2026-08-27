// The MEMORY domain, driven through its PRODUCTION seam (PR #1877, bead sparkle-jce9).
//
// These tests assert the SIDE EFFECT, not a precondition (AGENTS.md's #1 finding): that `remember`
// actually invokes the durable-write command with the right arguments, and that a value written
// through `remember` comes back out of `recall` — a real persist→recall round trip against a
// stateful fake of the `bd`-backed store. The handlers run with their DEFAULT deps
// (`LIVE_MEMORY_DEPS`), so the one line that wires `invoke` into the domain — the production call
// site AGENTS.md's "defaulted seam" warning is about — is itself under test, not replaced.
import { beforeEach, describe, expect, it, vi } from "vitest";

// A stateful fake of the app-side `bd` memory store. `remember`/`forget` mutate it; `recall`
// serializes it the way `bd memories --json` does (a key→value map, plus the `schema_version`
// bookkeeping key that is NOT a memory). This is what makes "written then read back" a real
// assertion rather than a mock echoing its input.
const store = new Map<string, string>();
const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  if (cmd === "concierge_memory_remember") {
    store.set(args.key as string, args.value as string);
    return "ok";
  }
  if (cmd === "concierge_memory_forget") {
    store.delete(args.key as string);
    return "ok";
  }
  if (cmd === "concierge_memory_recall") {
    const q = (args.query as string | null) ?? null;
    const obj: Record<string, unknown> = { schema_version: 1 };
    for (const [k, v] of store) {
      if (!q || k.includes(q) || v.includes(q)) obj[k] = v;
    }
    return JSON.stringify(obj);
  }
  throw new Error(`unexpected command ${cmd}`);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [string, Record<string, unknown>])) }));

import {
  forgetMemory,
  listMemories,
  MAX_RECALL_MEMORIES,
  recallMemory,
  rememberMemory,
  shapeMemories,
} from "./memory";

beforeEach(() => {
  store.clear();
  invoke.mockClear();
});

describe("remember", () => {
  it("invokes the durable-write command with the (trimmed) key and value, and reports the key", async () => {
    const res = await rememberMemory("  founder-priority  ", "  wall-clock speed over token cost  ");

    // THE SIDE EFFECT: the write actually reached the exec seam, trimmed.
    expect(invoke).toHaveBeenCalledWith("concierge_memory_remember", {
      key: "founder-priority",
      value: "wall-clock speed over token cost",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.key).toBe("founder-priority");
  });

  it("refuses an empty key or value WITHOUT writing", async () => {
    const noKey = await rememberMemory("   ", "something");
    const noVal = await rememberMemory("k", "   ");
    expect(noKey.ok).toBe(false);
    expect(noVal.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("persist → recall round trip", () => {
  it("returns a value that was written through remember", async () => {
    await rememberMemory("account-storytell", "Storytell owns the concierge memory work (PR #1877)");

    const found = await recallMemory("Storytell");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const hit = found.data.memories.find((m) => m.key === "account-storytell");
    // The VALUE survives the write and the read — not merely that a row exists.
    expect(hit?.value).toBe("Storytell owns the concierge memory work (PR #1877)");
    // …and it was fetched through the recall command, with the query forwarded.
    expect(invoke).toHaveBeenCalledWith("concierge_memory_recall", { query: "Storytell" });
  });

  it("does not return a value after it is forgotten", async () => {
    await rememberMemory("temp", "ephemeral fact");
    await forgetMemory("temp");

    const after = await listMemories();
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.data.memories.some((m) => m.key === "temp")).toBe(false);
    expect(invoke).toHaveBeenCalledWith("concierge_memory_forget", { key: "temp" });
  });

  it("lists everything with a null query", async () => {
    await rememberMemory("a", "alpha");
    await rememberMemory("b", "beta");

    const all = await listMemories();
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.total).toBe(2);
    expect(all.data.memories.map((m) => m.key)).toEqual(["a", "b"]);
    // list is the recall path with a NULL query — that is what reaches the store.
    expect(invoke).toHaveBeenCalledWith("concierge_memory_recall", { query: null });
  });
});

describe("shapeMemories", () => {
  it("drops the schema_version bookkeeping key; the key is only the LAST-RESORT tiebreak", () => {
    const shaped = shapeMemories({ schema_version: "1", zebra: "z", apple: "a" });
    expect(shaped.memories.map((m) => m.key)).toEqual(["apple", "zebra"]);
    expect(shaped.total).toBe(2);
  });

  it("caps the rendered list but reports the true total", () => {
    const raw: Record<string, string> = {};
    for (let i = 0; i < MAX_RECALL_MEMORIES + 5; i++) raw[`k${String(i).padStart(2, "0")}`] = `v${i}`;
    const shaped = shapeMemories(raw);
    expect(shaped.memories.length).toBe(MAX_RECALL_MEMORIES);
    expect(shaped.total).toBe(MAX_RECALL_MEMORIES + 5);
  });
});

// ═══ WHICH memories survive the cap (bead sparkle-h2a492 / sparkle-b0ip2v) ══════════════════════
//
// The regression these pin: the cap used to be applied AFTER an alphabetical key sort, so a fact was
// invisible-forever on the strength of its key's FIRST LETTER — measured at 17 of 42 memories never
// reaching the prompt, one of them naming a P0 blocker. The assertions are on the SIDE EFFECT (which
// keys actually come back in `memories`), never on the sort call.
describe("shapeMemories ordering — the cap must never fall alphabetically", () => {
  it("keeps an explicitly-important fact even when its key sorts DEAD LAST", () => {
    const raw: Record<string, string> = {};
    for (let i = 0; i < MAX_RECALL_MEMORIES; i++) {
      raw[`a-filler-${String(i).padStart(2, "0")}`] = "a routine note nobody is waiting on";
    }
    raw["zz-release-blocker"] = "P0: the notarization cert expires Friday and no DMG can ship.";
    const shaped = shapeMemories(raw);
    expect(shaped.memories.map((m) => m.key)).toContain("zz-release-blocker");
  });

  it("ranks a STANDING (undated) rule ahead of a stale episodic note whose key sorts earlier", () => {
    const shaped = shapeMemories({
      "aaa-handoff-2026-01-02": "HANDOFF (2026-01-02): status of a branch that has long since landed.",
      "zzz-founder-preference": "Never use emoji as icons — react-icons/fi only.",
    });
    expect(shaped.memories.map((m) => m.key)).toEqual([
      "zzz-founder-preference",
      "aaa-handoff-2026-01-02",
    ]);
  });

  it("orders dated facts NEWEST-first, in defiance of their keys", () => {
    const shaped = shapeMemories({
      "aaa-old": "As of 2026-01-02 the release runner was hosted.",
      "zzz-new": "As of 2026-08-20 the release runner is self-hosted.",
    });
    expect(shaped.memories.map((m) => m.key)).toEqual(["zzz-new", "aaa-old"]);
  });

  it("NAMES every fact the cap held back — nothing is silently unreachable", () => {
    const raw: Record<string, string> = {};
    for (let i = 0; i < MAX_RECALL_MEMORIES + 3; i++) {
      raw[`k${String(i).padStart(2, "0")}`] = `body ${i}`;
    }
    const shaped = shapeMemories(raw);
    expect(shaped.memories.length).toBe(MAX_RECALL_MEMORIES);
    // The withheld facts are reported BY NAME, so `recall <key>` can still reach every one of them.
    expect(shaped.hiddenKeys.length).toBe(3);
    expect([...shaped.memories.map((m) => m.key), ...shaped.hiddenKeys].sort()).toEqual(
      Object.keys(raw).sort(),
    );
  });

  it("reports NO hidden keys when the whole store fits", () => {
    expect(shapeMemories({ a: "alpha", b: "beta" }).hiddenKeys).toEqual([]);
  });
});

describe("failure handling", () => {
  it("turns a store error into a refusal, not a throw", async () => {
    invoke.mockRejectedValueOnce(new Error("locked by another dolt process"));
    const res = await recallMemory("anything");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("recall-failed");
      expect(res.message).toContain("locked by another dolt process");
    }
  });
});
