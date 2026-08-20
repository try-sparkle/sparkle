// WHICH MODEL REVIEWS THE PLAN — resolved, never hardcoded to a tier.
//
// The entire premise of the advisor pass is that a model reviewing its OWN plan shares its own blind
// spots. So the one property this module must guarantee is negative: **the advisor never runs on the
// planner's model.** A resolution that quietly falls back to it does not degrade the feature, it
// INVERTS it — self-review wearing a second name, with a bead comment attesting to a second opinion
// that never happened. That is worse than no advisor, which is why every failure here returns `null`
// (SKIP, with a reason) rather than a best-effort id.
//
// ══ WHY THE CATALOG IS THE CURATED LIST AND NOT A FETCH ═════════════════════════════════════════
//
// `model_catalog.rs` ALWAYS returns an empty vec, deliberately — it was the last code path in the
// desktop able to reach an Anthropic API key, and "no code path can reach an Anthropic API key" is
// an enforced invariant with a test. `services/models.ts` treats an empty dynamic list as "use the
// curated fallback", so `getModelCatalog()` is in practice `CLAUDE_MODELS`. That is the same list
// `set_agent_model` validates against (`controlListener.ts`), and reusing it is the point: a model
// this app may not set on an agent is not one it may dispatch an advisor on either.
//
// PURE. The catalog and the planner's model are both passed in, so every branch below is a unit test
// with no store, no Tauri and no AI call.
import { DEFAULT_MODEL_ID, type ClaudeModelOption } from "../models";

/** Why no advisor model could be resolved. Closed, so the audit note and the tests enumerate one
 *  set — and so a new skip path cannot ship without a sentence a human can read. */
export type AdvisorModelSkipReason =
  /** The catalog offered nothing that is not the planner's own model. */
  | "no-distinct-model"
  /** The catalog was empty (or held only the Default sentinel). */
  | "empty-catalog"
  /** The planner's model could not be read, so "different from the planner" is unanswerable. */
  | "planner-model-unknown";

export type AdvisorModelResolution =
  | { model: string; source: "configured" | "catalog" }
  | { model: null; reason: AdvisorModelSkipReason };

export const ADVISOR_MODEL_SKIP_TEXT: Record<AdvisorModelSkipReason, string> = {
  "no-distinct-model":
    "the model catalog offers nothing other than the planner's own model, so an advisor call would be self-review",
  "empty-catalog": "the model catalog is empty, so no advisor model could be named",
  "planner-model-unknown":
    "the planner's own model could not be read, so 'a model different from the planner' is unanswerable and the pass fails closed",
};

export interface ResolveAdvisorModelArgs {
  /** `[advisor].model` from `.sparkle/config.toml`, or null/undefined when unset. */
  configured?: string | null;
  /** The live model catalog — `getModelCatalog()` in production. */
  catalog: readonly ClaudeModelOption[];
  /**
   * The PLANNER's effective model id (`ai.rs` `CHAT_MODEL`, read through the `planner_chat_model`
   * command). `null` when it could not be read — which SKIPS rather than defaulting, because a
   * guessed planner id is the one input that can silently re-enable self-review.
   */
  plannerModel: string | null;
}

/**
 * Resolve the advisor's model as "a model DIFFERENT from the planner's", in three rules:
 *
 *   1. `[advisor].model` from config, IF that id is in the catalog and is not the planner's.
 *   2. else the first catalog entry that is neither the Default sentinel nor the planner's model.
 *   3. else `null` — SKIP with a reason.
 *
 * ── THE DEFAULT SENTINEL IS EXCLUDED, AND THAT IS RULE 1'S REAL EDGE ─────────────────────────────
 * `DEFAULT_MODEL_ID` ("default") is the head of every catalog and means "no `--model` flag — inherit
 * the user's own Claude Code default". It is not a model id at all: dispatched, it resolves to
 * whatever that user configured, which may well BE the planner's model — so admitting it would defeat
 * the one guarantee this module exists to make, by naming a value that cannot be compared against the
 * planner's until after the call has already run.
 *
 * ── A CONFIGURED ID ABSENT FROM THE CATALOG IS IGNORED, NOT OBEYED ──────────────────────────────
 * It falls through to rule 2 rather than being dispatched. `research.rs` refuses an off-list id at
 * dispatch anyway (`resolve_research_model`), so obeying it here would only move the failure later
 * and spend a bead label on it; and a typo in a hand-edited TOML must cost that one knob, which is
 * the same discipline `apply_pushers` follows for every other key.
 */
export function resolveAdvisorModel(args: ResolveAdvisorModelArgs): AdvisorModelResolution {
  const { configured, catalog, plannerModel } = args;

  // FAIL CLOSED on an unreadable planner model. Without it, "different from the planner" has no
  // referent, and the only available fallback — pick anything — is exactly the self-review case.
  const planner = plannerModel?.trim();
  if (!planner) return { model: null, reason: "planner-model-unknown" };

  const usable = catalog.filter((m) => m.id !== DEFAULT_MODEL_ID && m.id.trim().length > 0);
  if (usable.length === 0) return { model: null, reason: "empty-catalog" };

  const wanted = configured?.trim();
  if (wanted && wanted !== planner && usable.some((m) => m.id === wanted)) {
    return { model: wanted, source: "configured" };
  }

  const first = usable.find((m) => m.id !== planner);
  if (first) return { model: first.id, source: "catalog" };
  return { model: null, reason: "no-distinct-model" };
}
