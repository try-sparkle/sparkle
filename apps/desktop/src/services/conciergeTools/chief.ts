// The CHIEF domain — the concierge's reach into Chief, where the founder's real client work lives
// (bead `sparkle-8rr0c`). This module is the CLASSIFICATION half only: the operation names and how
// dangerous each one is. It reads no store, calls no network, and imports nothing but types.
//
// TWO GATES SIT IN FRONT OF EVERY CALL, AND THIS IS NEITHER OF THEM. `services/chiefScope.ts`
// answers WHICH PROJECT a call may run against and WHICH VERBS a build agent may use; this file
// answers a third, separate question — how much the CONCIERGE may do on its own before checking in
// with the human. They are independent on purpose: scope is about authority the app grants, policy is
// about autonomy the human grants, and a call has to clear both.
//
// WHY THE NAMES CARRY A `chief_` PREFIX. Every other domain here publishes bare op names (`list`,
// `get`, `dispatch`), and those names are CONFIG KEYS the human types into `[concierge.tools]` — so
// they must be unique across the whole catalog (policy.test.ts pins that). Chief's vocabulary is
// upstream's, not ours, and it collides head-on: `list_projects` is already a workspace op, and
// `list`/`get` are already research ops. The prefix is what keeps one shared namespace honest, and it
// is also what a human reading their own config file needs in order to tell "list the Sparkle
// projects on this machine" from "list the 348 Chief projects this token can reach".
//
// THE DESTRUCTIVE TOOLS ARE DELIBERATELY ABSENT. `CHIEF_DESTRUCTIVE_TOOLS` in chiefScope.ts names
// thirteen upstream verbs (`delete_chat`, `update_project`, …) that are refused outright for build
// agents. None of them is a first-class concierge tool, and adding one here would be the wrong
// remedy twice over: it would put a togglable Settings row in front of a verb whose real gate lives
// in the scope layer, and it would invite the pane to describe an authority the app does not grant.
// The concierge reaches them — when it genuinely must — through `chief_call`, which passes its `tool`
// argument through `checkChiefTool` and is classified below as the escape hatch it is.
// `chief.test.ts` asserts no op here names a destructive verb, so that stays true by test rather
// than by everyone remembering it.

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

/**
 * Every Chief operation the concierge can name, in the order the settings pane lists them: the seven
 * reads first, then the four writes, then the hatch.
 *
 * This is a SUBSET of Chief's surface (58 tools as of 2026-08-12), chosen rather than mirrored. A
 * generated one-to-one wrapper would put fifty-odd rows in the human's settings pane, most of them
 * for verbs nobody will ask for, and would re-classify itself every time Chief shipped a release.
 * The eleven named tools are the ones the concierge actually does its job with; anything rarer goes
 * through `chief_call`, which is gated harder precisely because it is open-ended.
 */
export const CHIEF_OPS = [
  // Reads.
  "chief_list_projects",
  "chief_list_assets",
  "chief_get_asset",
  "chief_list_chats",
  "chief_list_messages",
  "chief_list_memories",
  "chief_list_skills",
  // Writes.
  "chief_create_chat",
  "chief_send_message",
  "chief_upload_file",
  "chief_create_memory",
  // The escape hatch.
  "chief_call",
] as const;

export type ChiefOp = (typeof CHIEF_OPS)[number];

/** Two words, both members of the vocabulary the workflow domain already publishes, so policy.ts
 *  reuses that translation rather than declaring a table identical to it. Adding a third word here
 *  fails to compile there until someone decides what it means in the shared vocabulary. */
export type ChiefRisk = "read-only" | "outward-facing";

/**
 * EXHAUSTIVE by construction — `Record<ChiefOp, ChiefRisk>`, so an op added to {@link CHIEF_OPS}
 * without a classification fails `tsc` rather than arriving at the policy layer unclassified. The
 * derived defaults come from here (`read-only` → allow, `outward-facing` → ask); nothing hand-lists
 * a per-tool decision anywhere.
 *
 * THE READS ARE `read-only` IN THE STRONGEST SENSE — they change nothing in Chief and nothing here.
 * That they cross the network does not make them outward-facing in this vocabulary: the class is
 * about reaching other PEOPLE, and a read leaves no trace anyone will see.
 *
 * THE WRITES ARE `outward-facing`, AND THAT IS THE WHOLE POINT OF THE CLASS. A chat, a message, an
 * uploaded file or a saved memory lands in a REAL CLIENT'S project — someone who is not the founder
 * will read it, and no undo in this app takes it back out of their inbox. `routine` ("local and
 * reversible") would be false on both halves of its own definition, and it derives to `allow`, which
 * is how a model gets to send mail on someone's behalf without anyone deciding it could.
 *
 * `chief_call` IS `outward-facing` BECAUSE OF WHAT IT COULD BE, NOT WHAT IT USUALLY IS. It names an
 * arbitrary upstream tool, so its risk is not knowable from the call site at classification time —
 * and the honest reading of "this might be any verb Chief has" is the stricter one. Classifying it
 * `read-only` because most uses of it will be reads would hand the model one auto-allowed tool that
 * reaches every verb the eleven named ones were split apart to gate.
 *
 * THE NAME-KEYED CLASS IS A FLOOR UNDER THE HATCH, NOT THE WHOLE GATE (roborev 63041). Because this
 * is the only route the concierge has to Chief's DESTRUCTIVE verbs — `checkChiefTool` passes a
 * concierge caller unconditionally, by design — policy.ts's `PER_CALL_RISK` reads this op's `tool`
 * argument and escalates a destructive name to `irreversible`, which an explicit `allow` cannot
 * cover. That direction is the only one permitted: escalating on model-supplied arguments is safe,
 * while RELAXING on them (letting the hatch argue its way down to `allow` by naming a read) would be
 * the model approving itself, so nothing does that.
 */
export const CHIEF_RISK: Record<ChiefOp, ChiefRisk> = {
  chief_list_projects: "read-only",
  chief_list_assets: "read-only",
  chief_get_asset: "read-only",
  chief_list_chats: "read-only",
  chief_list_messages: "read-only",
  chief_list_memories: "read-only",
  chief_list_skills: "read-only",
  chief_create_chat: "outward-facing",
  chief_send_message: "outward-facing",
  chief_upload_file: "outward-facing",
  chief_create_memory: "outward-facing",
  chief_call: "outward-facing",
};

// ---------------------------------------------------------------------------------------------
// The hatch's argument shape + name spelling — frozen HERE so two readers cannot disagree
// ---------------------------------------------------------------------------------------------

/**
 * The key `chief_call` names its upstream tool with.
 *
 * A CONSTANT rather than a literal typed twice, because the two readers of this key are written by
 * different people at different times: the registry's zod schema, and policy.ts's per-call floor.
 * If the schema lands as `toolName` or nests the call under a wrapper, the floor's reader returns
 * null, the call falls back to the name-keyed `outward-facing`, and an explicit `allow` covers a
 * destructive verb again — silently, with every test still green, because the fixtures would be
 * written to match the READER rather than the producer (roborev 63045; the same shape AGENTS.md
 * records for the Rust `Option` seam). Derive the schema from this and that cannot happen.
 */
export const CHIEF_CALL_TOOL_ARG = "tool";

/**
 * What `chief_call` takes. The registry's schema MUST be derived from this — and NOTHING ENFORCES
 * THAT YET. Read the next paragraph before trusting this type.
 *
 * The key is mapped from the constant rather than retyped (roborev 63051), so the two cannot drift
 * WITHIN this module: written as `interface ChiefCallArgs { tool: string }`, renaming
 * `CHIEF_CALL_TOOL_ARG` left the type still saying `tool` and nothing failed to compile.
 *
 * WHAT THAT DOES NOT BUY, STATED PLAINLY BECAUSE AN EARLIER VERSION OF THIS COMMENT CLAIMED IT DID
 * (roborev 63053). There is no `chief` entry in registry.ts and no schema importing this type, so a
 * hand-written `z.object({ toolName: z.string() })` over there compiles perfectly: this module's
 * reader would then find no `tool` key, `PER_CALL_RISK.chief_call` would fall through to the
 * name-keyed `outward-facing`, and an explicit `chief_call = "allow"` would cover
 * `{toolName: "delete_chat"}` unprompted — the exact hole the floor exists to close, with every
 * test in this branch still green because they are all keyed off the same constant.
 *
 * So this is a CONTRACT ADDRESSED TO THE REGISTRY AUTHOR, not a guarantee the compiler keeps: build
 * the schema's key from `CHIEF_CALL_TOOL_ARG`, and add a test asserting the schema's key set equals
 * `[CHIEF_CALL_TOOL_ARG, "arguments"]` — that test is the thing that would make this enforceable,
 * and it cannot be written here because the schema does not exist yet.
 */
export type ChiefCallArgs = Record<typeof CHIEF_CALL_TOOL_ARG, string> & {
  /** The named tool's own arguments, passed through untouched. */
  arguments?: Record<string, unknown>;
};

/**
 * The upstream tool name out of a RAW, UNVALIDATED `chief_call` payload, or null when this does not
 * look like one.
 *
 * Total over arbitrary JSON on purpose: the policy layer is consulted BEFORE the registry's zod
 * runs, so this sees whatever the model sent. Null means "no opinion", never "safe".
 *
 * THE VALUE IS READ AS `unknown`, DELIBERATELY. Casting to `Partial<ChiefCallArgs>` would type it
 * `string | undefined` — a lie about model-supplied input, and one that makes the `typeof` check
 * below look redundant, so a later edit to `value?.trim()` would compile while a numeric `tool`
 * reached `normalizeChiefToolName` and threw inside a policy evaluation (roborev 63053). The cast
 * bought nothing in exchange: indexing a type derived from the constant WITH that constant is
 * well-typed for every possible value of the constant, so it could never have caught a rename.
 */
export function chiefCallToolName(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const value: unknown = (args as Record<string, unknown>)[CHIEF_CALL_TOOL_ARG];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * One spelling of a Chief tool name, for comparison against `CHIEF_DESTRUCTIVE_TOOLS`.
 *
 * THE DURABLE FIX LANDED: this is now re-exported from `chiefScope.ts`, where it lives next to the
 * set it guards. It used to be declared here, and that gap was a real hole rather than a tidiness
 * complaint — this module folded names before its own floor while `checkChiefTool` compared RAW, so
 * `mcp__chief__delete_asset` and `Delete_Asset` walked straight through the access-control gate
 * (roborev 63036). The asymmetry this comment used to describe as deliberate is gone: one
 * normalizer, applied by both.
 *
 * Kept as a re-export rather than asking every caller to re-point, so `policy.ts` and this module's
 * own readers keep one import.
 */
import { normalizeChiefToolName } from "../chiefScope";
export { normalizeChiefToolName };

/**
 * The policy op that governs ONE Chief call, from the UPSTREAM tool name it will actually run.
 *
 * This is the seam that makes everything above reachable. The classification here is keyed on
 * `chief_*` op names, but the wire carries an upstream verb (`list_assets`, `delete_chat`) on a
 * single control op, so without this translation the whole table is decoration — which is exactly
 * what shipped: the transport landed with its op exempted from the concierge gate on the grounds
 * that "no policy entry describes it", while these entries existed and nothing consulted them
 * (roborev 63072).
 *
 * ANYTHING NOT NAMED FALLS TO `chief_call`, AND THAT IS THE SAFE DIRECTION, not a gap. The eleven
 * first-class ops are reads and ordinary writes; every DESTRUCTIVE verb is unnamed by construction
 * (`chief.test.ts` pins that no `CHIEF_OPS` entry is in `CHIEF_DESTRUCTIVE_TOOLS`), so a destructive
 * verb can only ever land on `chief_call` — whose `outward-facing` class asks by default and whose
 * per-call floor escalates it to `irreversible`, which an explicit `allow` cannot cover. A new
 * upstream verb nobody has classified lands there too, and asking about an unknown verb is the
 * answer we want.
 *
 * Normalizing before the lookup is what stops `MCP__CHIEF__LIST_ASSETS` from missing the named row
 * and being asked about — the reverse of the usual worry, and still worth avoiding: an approval card
 * for a plain read trains the human to click through them.
 */
export function chiefPolicyOpFor(upstreamTool: string): ChiefOp {
  const named = `chief_${normalizeChiefToolName(upstreamTool)}`;
  return (CHIEF_OPS as readonly string[]).includes(named) ? (named as ChiefOp) : "chief_call";
}
