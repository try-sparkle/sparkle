// The CHIEF domain's own classification invariants — the ones that are properties of THIS module
// rather than of the policy layer it feeds. The derived decisions (a read allows, a write asks,
// `chief_call` asks, an unknown `chief_*` name is denied) are asserted in policy.test.ts, against
// `evaluateToolPolicy`, because that is where they actually take effect.
//
// What is left here is the pair of facts nothing downstream can check for itself:
//   1. every op is namespaced, because these names are config keys in ONE shared table;
//   2. no op names a verb that DESTROYS Chief data, because that gate lives in chiefScope.ts and a
//      first-class tool would quietly route around it.
import { describe, expect, it } from "vitest";

import {
  CHIEF_CALL_TOOL_ARG,
  CHIEF_OPS,
  CHIEF_RISK,
  chiefCallToolName,
  chiefPolicyOpFor,
  normalizeChiefToolName,
  type ChiefOp,
} from "./chief";
import { CHIEF_DESTRUCTIVE_TOOLS, isDestructiveChiefTool } from "../chiefScope";

/** The upstream Chief tool a first-class op corresponds to — the op name minus its namespace. */
function upstreamName(op: ChiefOp): string {
  return op.replace(/^chief_/, "");
}

describe("the Chief op surface", () => {
  it("namespaces every op, because these names are keys in ONE shared config table", () => {
    // Chief's vocabulary is upstream's and it collides with ours: `list_projects` is already a
    // workspace op, `list`/`get` are already research ops. A bare name here would make one domain's
    // risk silently win the other's — policy.test.ts's no-duplicates assertion is the other half of
    // this, and this is the half that says WHY the names look the way they do.
    for (const op of CHIEF_OPS) {
      expect(op.startsWith("chief_"), op).toBe(true);
      expect(upstreamName(op).length, op).toBeGreaterThan(0);
    }
    expect(new Set(CHIEF_OPS).size).toBe(CHIEF_OPS.length);
  });

  it("classifies every op, and only its own ops", () => {
    // `Record<ChiefOp, ChiefRisk>` makes both directions a compile error; this is the runtime mirror,
    // so the type and the table cannot disagree if someone loosens the annotation.
    expect(Object.keys(CHIEF_RISK).sort()).toEqual([...CHIEF_OPS].sort());
    for (const op of CHIEF_OPS) {
      expect(["read-only", "outward-facing"], op).toContain(CHIEF_RISK[op]);
    }
  });

  it("names NO destructive Chief verb as a first-class tool", () => {
    // `CHIEF_DESTRUCTIVE_TOOLS` is refused outright for build agents (chiefScope.ts's verb gate), and
    // the concierge reaches those verbs only through `chief_call`, which passes its `tool` argument
    // through that same gate. A first-class `chief_delete_chat` would put a togglable Settings row in
    // front of a verb whose real gate lives somewhere else — so this asserts the absence, rather than
    // leaving it to everyone remembering the rule.
    // ASKED OF THE PREDICATE, NOT OF THE NAME SET (roborev 63136). "Is this verb destructive" is
    // `isDestructiveChiefTool` — a structural rule over the name floor — and this guard used to ask
    // only the floor, so the two answers diverged the moment the rule landed. A first-class
    // `chief_update_memory` or `chief_archive_chat` would have left this green while
    // `checkChiefTool` refused the identical verb for every build agent: precisely the "togglable
    // Settings row in front of a verb whose real gate lives elsewhere" state this test exists to
    // prevent, now reachable through the gap between two ways of asking the same question.
    for (const op of CHIEF_OPS) {
      expect(isDestructiveChiefTool(upstreamName(op)), op).toBe(false);
    }
    // …and the guard is only worth anything if the thing it consults really does refuse the names
    // one would reach for. Without these, gutting the rule upstream would leave the loop above
    // passing vacuously.
    expect(CHIEF_DESTRUCTIVE_TOOLS.size).toBeGreaterThan(5);
    expect(isDestructiveChiefTool("delete_chat")).toBe(true);
    expect(isDestructiveChiefTool("create_share_link")).toBe(true);
    expect(isDestructiveChiefTool("update_memory")).toBe(true);
  });

  it("classifies anything that WRITES to a client's project as outward-facing", () => {
    // Hand-written rather than derived from the map — a list computed from `CHIEF_RISK` would agree
    // with it no matter what it said. `create`/`send`/`upload` is the shape of a write; every one of
    // them lands in front of someone who is not the user, and nothing in this app takes it back.
    const writes = CHIEF_OPS.filter((op) => /^chief_(create|send|upload|update|delete)_/.test(op));
    expect(writes.length).toBeGreaterThan(0);
    for (const op of writes) expect(CHIEF_RISK[op], op).toBe("outward-facing");
    // The reads are the complement, and they must NOT have been swept into the same class — a
    // domain that asks about everything is one the human turns off wholesale.
    const reads = CHIEF_OPS.filter(
      (op) => !writes.includes(op) && op !== "chief_call",
    );
    expect(reads.length).toBeGreaterThan(writes.length);
    for (const op of reads) expect(CHIEF_RISK[op], op).toBe("read-only");
  });

  it("does not treat the escape hatch as a read", () => {
    expect(CHIEF_RISK.chief_call).not.toBe("read-only");
  });
});

// ══ THE HATCH'S ARGUMENT SHAPE AND NAME SPELLING (roborev 63045) ════════════════════════════════
// Both exist so that TWO readers — the registry's zod schema and policy.ts's per-call floor — cannot
// disagree about what a `chief_call` payload looks like or about when two strings name one verb.
// Getting either wrong fails in the silent, permissive direction: the floor returns null, the call
// falls back to `outward-facing`, and an explicit `allow` covers a destructive verb again.
describe("chiefCallToolName — reading a RAW payload", () => {
  it("returns the name for the shape the schema is meant to be derived from", () => {
    expect(CHIEF_CALL_TOOL_ARG).toBe("tool");
    expect(chiefCallToolName({ tool: "delete_chat" })).toBe("delete_chat");
    expect(chiefCallToolName({ tool: "list_chats", arguments: { chat_id: "c1" } })).toBe(
      "list_chats",
    );
    // Read through the constant, so a rename moves the fixture with the code rather than leaving
    // this test asserting a key nothing sends.
    expect(chiefCallToolName({ [CHIEF_CALL_TOOL_ARG]: "x" })).toBe("x");
  });

  it("does not throw on a non-string `tool`, which is what keeps the policy evaluation total", () => {
    // roborev 63053. The reader deliberately types the value `unknown` rather than casting to
    // `Partial<ChiefCallArgs>` (which would say `string | undefined`), so the `typeof` check stays
    // load-bearing instead of looking redundant. This is the consequence that matters: a numeric
    // `tool` must not reach `normalizeChiefToolName`, whose `.trim()` would throw INSIDE a policy
    // evaluation — i.e. inside the gate, on model-supplied input.
    for (const tool of [42, true, { nested: "delete_chat" }, ["delete_chat"], null]) {
      expect(() => chiefCallToolName({ tool })).not.toThrow();
      expect(chiefCallToolName({ tool }), String(tool)).toBeNull();
    }
  });

  it("is total over arbitrary JSON and answers null rather than throwing", () => {
    // The policy layer runs BEFORE the registry's zod, so this sees whatever the model sent.
    for (const args of [
      undefined,
      null,
      42,
      "delete_chat",
      ["delete_chat"],
      {},
      { tool: 1 },
      { tool: null },
      { tool: ["delete_chat"] },
      { tool: "   " },
      { toolName: "delete_chat" },
      { call: { tool: "delete_chat" } },
    ]) {
      expect(chiefCallToolName(args), JSON.stringify(args) ?? "undefined").toBeNull();
    }
  });
});

describe("normalizeChiefToolName — one spelling per verb", () => {
  it("folds padding, case, and the mcp__<server>__ wire prefix onto the set's own spelling", () => {
    for (const raw of [
      "delete_chat",
      " delete_chat ",
      "DELETE_CHAT",
      "Delete_Chat",
      "mcp__chief__delete_chat",
      "  MCP__CHIEF__delete_chat\t",
    ]) {
      expect(normalizeChiefToolName(raw), raw).toBe("delete_chat");
      // The point of the folding: the destructive set is keyed on that one spelling.
      expect(CHIEF_DESTRUCTIVE_TOOLS.has(normalizeChiefToolName(raw)), raw).toBe(true);
    }
  });

  it("does not fold two DIFFERENT verbs together", () => {
    // A normalizer that over-reaches would escalate ordinary reads and make the hatch useless.
    expect(normalizeChiefToolName("delete_chat_v2")).toBe("delete_chat_v2");
    expect(CHIEF_DESTRUCTIVE_TOOLS.has(normalizeChiefToolName("list_chats"))).toBe(false);
    expect(CHIEF_DESTRUCTIVE_TOOLS.has(normalizeChiefToolName("delete_chat_v2"))).toBe(false);
  });

  it("is STRICTER than the frozen contract's raw comparison, never looser", () => {
    // chiefScope.ts's `checkChiefTool` compares raw and is not this module's to change; the only
    // direction a floor may differ is by matching MORE names, which can only ask more often. This
    // asserts that relationship rather than leaving it as a comment: every name the raw check
    // catches, the normalized one catches too.
    for (const name of CHIEF_DESTRUCTIVE_TOOLS) {
      expect(CHIEF_DESTRUCTIVE_TOOLS.has(normalizeChiefToolName(name)), name).toBe(true);
    }
  });
});

describe("chiefPolicyOpFor — the upstream verb onto the op that governs it", () => {
  it("maps every first-class op's own verb back onto that op", () => {
    // Derived from CHIEF_OPS rather than listed, so an op added upstream cannot be left out of the
    // translation while this test keeps passing on the eleven that were hand-written.
    for (const op of CHIEF_OPS) {
      if (op === "chief_call") continue;
      expect(chiefPolicyOpFor(upstreamName(op)), op).toBe(op);
    }
  });

  it("sends EVERY destructive verb to chief_call — the only op with a floor under it", () => {
    // The load-bearing case. `chief_call` is the one op whose per-call rule reads the verb and
    // escalates it to `irreversible`; a destructive verb landing on any other op would be governed
    // by that op's name-keyed class instead, which an explicit `allow` covers. This is derived from
    // the destructive set itself, so a verb added there is covered the day it is added.
    for (const verb of CHIEF_DESTRUCTIVE_TOOLS) {
      expect(chiefPolicyOpFor(verb), verb).toBe("chief_call");
    }
  });

  it("sends an unknown verb to chief_call rather than inventing an op for it", () => {
    // Chief owns this vocabulary and ships new tools; an unclassified one must ask, not fall
    // through. `""` is included because the caller reads it out of a model-supplied payload.
    expect(chiefPolicyOpFor("some_new_verb_chief_shipped")).toBe("chief_call");
    expect(chiefPolicyOpFor("")).toBe("chief_call");
  });

  it("folds spelling before the lookup, so a wire-prefixed read is not asked about", () => {
    // The reverse of the worry above and still worth pinning: an approval card in front of a plain
    // read is a card the human learns to dismiss.
    expect(chiefPolicyOpFor("MCP__CHIEF__list_assets")).toBe("chief_list_assets");
    expect(chiefPolicyOpFor("  list_chats  ")).toBe("chief_list_chats");
  });
});
