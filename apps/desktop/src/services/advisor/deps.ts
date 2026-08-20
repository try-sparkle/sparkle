// THE PRODUCTION WIRING — the one line that supplies the real backends to `pass.ts`.
//
// Kept in its own file, and reached through a FUNCTION rather than a defaulted parameter, for the
// reason AGENTS.md records as a repeated finding: a `deps = realThing` default that every test
// overrides leaves the production call site covered by nothing — delete it and the suite stays green
// while the bug comes back. Here the seam is the whole `AdvisorPassDeps` object, so a single test
// can drive the production path by calling `productionDeps()` itself, and `deps.test.ts`'s
// "the production reader" block does exactly that — it calls `readUsageForAllAccounts()` with NO
// arguments, so the default expressions below are executed rather than replaced.
import { invoke } from "@tauri-apps/api/core";

import { log } from "../../logger";
import { getAccountUsageLive } from "../accountUsage";
import { listAccounts } from "../accountStore";
import { commentBead, labelBead } from "../beads";
import { getConfig } from "../config";
import { getModelCatalog } from "../models";
import { dispatchResearch } from "../research/store";
import { resolveAdvisorConfig } from "./config";
import { productionLatch } from "./latch";
import { checkSpendGateForAccounts, type UsagePayloadForGate } from "./spendGate";
import type { AdvisorConfigView, AdvisorPassDeps } from "./pass";

/**
 * The `[advisor]` section, cached from the last `get_config`.
 *
 * `pass.ts` reads config SYNCHRONOUSLY (`config: () => AdvisorConfigView`) because it is called from
 * a path that must not add another await before the spend gate — and because a config read that
 * failed would otherwise have to invent an answer, which for a flag that ships ON means inventing
 * permission. So the value is refreshed out of band by {@link primeAdvisorConfig} and read from here.
 * Before the first prime it is the shipped default, which matches what `config.rs` would return for
 * a machine with no config file.
 */
let cachedConfig: AdvisorConfigView = resolveAdvisorConfig(undefined);

/** Refresh the cached `[advisor]` section. Called at wiring time and whenever config changes; safe
 *  to call repeatedly and never throws (a failed read leaves the previous value in place, which is
 *  the last thing the backend actually said). */
export async function primeAdvisorConfig(projectRoot?: string | null): Promise<void> {
  try {
    const eff = await getConfig(projectRoot ?? null);
    cachedConfig = resolveAdvisorConfig(eff.config.advisor);
  } catch (e) {
    log.warn("advisor", "could not read [advisor] config — keeping the last known value", e);
  }
}

/** Test seam: force the cached config, so the wiring test does not need a Tauri bridge. */
export function __setCachedAdvisorConfig(cfg: AdvisorConfigView): void {
  cachedConfig = cfg;
}

/**
 * Read the LIVE usage payload for EVERY registered account and fold them into one verdict input.
 *
 * ══ WHY EVERY ACCOUNT, NOT "THE ACTIVE ONE" ═════════════════════════════════════════════════════
 *
 * There is no active account to read here. The advisor's child is the user's own `claude` CLI
 * spawned by `research.rs`, and which registered config dir that resolves to is not a fact this
 * layer holds. Asking one account's meter would be a guess about which meter the call lands on, and
 * a wrong guess spends money against an instruction that admits no small amount — so the gate
 * requires UNANIMITY (see `checkSpendGateForAccounts`).
 *
 * A per-account read that REJECTS contributes `null`, which the gate refuses on. That is the point:
 * an account whose usage cannot be read is an account whose meter is unknown, and an unknown meter
 * is not permission.
 *
 * `force` is deliberately NOT passed. The forced read drops the Rust token cache and can raise a
 * macOS keychain prompt per account; a gate that popped a password dialog every time someone clicked
 * Build It would be its own outage. The cached path is a TTL cache of the TOKEN, not of the usage
 * numbers, so the figures are still fetched live.
 */
/**
 * The production usage read. A PLAIN CALL now — no cast.
 *
 * This used to be an unverifiable projection, and the comment that stood here said so at length:
 * `AccountUsageLive` carried no `extraUsage` field, so `account_usage.rs` discarded the whole
 * `extra_usage` block, every account folded to `usage-field-absent`, and **the gate refused
 * unconditionally in production** — correct fail-closed behaviour, and completely inert.
 *
 * Bead `sparkle-iclm0` landed the passthrough, so the type now exists and `tsc` checks this line.
 * The drift the old cast could not catch — serde's `rename_all` not descending into a nested
 * struct, emitting `extraUsage.is_enabled` and leaving the advisor off forever with nothing
 * reporting why — is now pinned on the Rust side by
 * `the_serialized_key_names_are_exactly_what_the_advisor_spend_gate_reads`, which asserts the
 * SERIALIZED json keys (the Rust field names are snake_case either way, so only that can tell the
 * correct and broken cases apart). The tripwire that stood in for it has been removed.
 *
 * `AccountUsageLive` satisfies `UsagePayloadForGate` structurally, so the gate still does not
 * import the concrete payload and stays testable with a literal.
 */
function defaultUsageRead(configDir: string): Promise<UsagePayloadForGate> {
  return getAccountUsageLive(configDir);
}

export async function readUsageForAllAccounts(
  // Injected so the FOLD BELOW is testable without a Tauri bridge. It is the one piece of production
  // wiring that transforms a verdict rather than forwarding a value, and a bug in it — a refusal
  // re-projected into a shape the gate reads as permission — would be completely invisible: the gate
  // and its 14 tests would all still pass while the machine spent money.
  read: (configDir: string) => Promise<UsagePayloadForGate> = defaultUsageRead,
  list: () => Promise<Array<{ configDir: string }>> = listAccounts,
): Promise<UsagePayloadForGate | null> {
  const accounts = await list();
  const payloads = await Promise.all(
    accounts.map(async (a) => {
      try {
        return await read(a.configDir);
      } catch {
        return null;
      }
    }),
  );
  const verdict = checkSpendGateForAccounts(payloads);
  // Re-projected into the single-payload shape `AdvisorPassDeps.readUsage` promises, so `pass.ts`
  // keeps ONE gate call rather than branching on how many accounts exist. A refusal is expressed by
  // handing back a payload the single-payload gate refuses on with the SAME reason — armed credits
  // stay "armed", everything else collapses to the unreadable/absent shapes, which is exactly what
  // the fold already decided.
  if (verdict.allowed) {
    return { extraUsage: { isEnabled: false, usedCredits: verdict.usedCreditsBefore } };
  }
  if (verdict.reason === "credits-armed") return { extraUsage: { isEnabled: true } };
  if (verdict.reason === "spend-limit-reached") {
    return { extraUsage: { isEnabled: false, spendLimitReached: true } };
  }
  if (verdict.reason === "usage-field-absent") return { extraUsage: {} };
  return null;
}

/** The planner's own model id (`ai.rs` CHAT_MODEL). `null` on any failure, which
 *  `resolveAdvisorModel` reads as "cannot answer 'different from the planner'" and SKIPS on. */
async function readPlannerModel(): Promise<string | null> {
  try {
    const id = await invoke<string>("planner_chat_model");
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch (e) {
    log.warn("advisor", "could not read the planner's model", e);
    return null;
  }
}

/** The real backends. */
export function productionDeps(): AdvisorPassDeps {
  return {
    readUsage: () => readUsageForAllAccounts(),
    plannerModel: readPlannerModel,
    catalog: getModelCatalog,
    config: () => cachedConfig,
    dispatchResearch: async (input) => {
      const task = await dispatchResearch({
        question: input.question,
        projectId: input.projectId,
        projectRoot: input.projectRoot,
        // `quick` and `deep` no longer buy different models or wall clocks (see `ResearchDepth` in
        // research.rs — the founder collapsed the tiers), so the label is the only difference and
        // the cheaper-sounding one is the honest description of a single-pass plan review.
        depth: "quick",
        model: input.model,
      });
      return { id: task.id };
    },
    labelBead,
    commentBead,
    latch: productionLatch,
    logError: (message, error) => log.error("advisor", message, error),
  };
}
