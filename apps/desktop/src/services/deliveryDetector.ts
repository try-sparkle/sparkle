// apps/desktop/src/services/deliveryDetector.ts
// Unit 3 of "Definable Done & Delivered" — the Delivery Detector.
//
// Answers "how does *this* project ship to production?" → a { method, confidence, note, criteria }
// proposal. The core is a PURE, deterministic classifier (`classifyEvidence`) over the repo-local
// evidence gathered by the Rust `collect_delivery_evidence` command. `detectDelivery` wraps it with
// the IPC call and an OPTIONAL Haiku enrichment pass that may only improve the human-readable note
// and the suggested criteria text — it can NEVER upgrade confidence above what the deterministic
// heuristic assigned.
//
// HONESTY is the whole point: confidence must reflect real evidence, and `none` is a first-class,
// legitimate result. We never fabricate a delivery method the evidence doesn't support. The Rust
// side deliberately ignores external dashboards (Vercel/Fly APIs), so everything here rests on git,
// GitHub-via-workflows, and package-registry evidence only.

import { invoke } from "@tauri-apps/api/core";
import { structuredJson } from "./anthropic";

// ---------------------------------------------------------------------------------------------
// Shared types.
//
// These canonically live in `stageDefs.ts` (Unit 2), authored by a parallel worker. That file does
// not exist in this worktree yet, so importing from it would break typecheck. We declare the
// minimal shapes locally for now.
//
// TODO: import from stageDefs once merged — replace this local block with:
//   import type { DeliveryMethod, Confidence, StageCriterion } from "./stageDefs";
// The definitions below are byte-compatible with the spec's stageDefs types.
// ---------------------------------------------------------------------------------------------
export type DeliveryMethod =
  | "release_tag"
  | "ci_deploy"
  | "merge_is_deploy"
  | "package_publish"
  | "unknown";
export type Confidence = "high" | "medium" | "low" | "none";
export type CriterionKind = "auto" | "manual";
export type AutoSignal = "merged_to_main" | "pr_merged" | "pushed" | "in_release";
export interface StageCriterion {
  text: string;
  kind: CriterionKind;
  signal?: AutoSignal;
}

/** The detector's answer for a project: the ranked delivery method, how confident we are, a
 *  one-line human-readable note, and the suggested Delivered criteria to seed the definition. */
export interface DeliveryProposal {
  method: DeliveryMethod;
  confidence: Confidence;
  note: string;
  criteria: StageCriterion[];
}

/** Mirror of the Rust `DeliveryEvidence` struct (serde camelCase). Every field is best-effort;
 *  absence is a legitimate falsy value, never an error. Kept flat + JSON-friendly on purpose so the
 *  classifier stays a pure function over primitives. */
export interface DeliveryEvidence {
  hasVercel: boolean;
  hasFly: boolean;
  hasNetlify: boolean;
  hasDockerfile: boolean;
  hasEas: boolean;
  hasServerless: boolean;
  npmPublishable: boolean;
  packageName: string | null;
  packageVersion: string | null;
  packagePrivate: boolean;
  hasPublishConfig: boolean;
  releaseScript: string | null;
  workflowDeployVerbs: string[];
  workflowFiles: string[];
  hasSemverTags: boolean;
  tagCount: number;
  remotes: string[];
  defaultBranch: string | null;
}

/** The auto-signal that a Delivered criterion watches: the merge commit is contained in a shipped
 *  release. Matches the `in_release` `AutoSignal` in stageDefs. */
const IN_RELEASE_SIGNAL: AutoSignal = "in_release";

/** Confidence ordering, so we can assert Haiku never upgrades past the heuristic. */
const CONFIDENCE_RANK: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 };

function has(verbs: string[], verb: string): boolean {
  return verbs.some((v) => v.toLowerCase() === verb.toLowerCase());
}

/**
 * PURE, deterministic evidence → proposal classifier. This is the testable core; the decision must
 * stand entirely on its own (no I/O, no Haiku). Precedence (first match wins):
 *
 *   1. release workflow (`gh release` / `action-gh-release`) OR `cut-dmg` release script OR semver
 *      tags                                   ⇒ release_tag, HIGH
 *   2. a workflow deploy verb (vercel/fly/eas) ⇒ ci_deploy,   HIGH  (note names which)
 *   3. vercel.json / netlify.toml, NO deploy workflow ⇒ merge_is_deploy, MEDIUM
 *   4. npm-publishable + `npm publish` verb    ⇒ package_publish, MEDIUM
 *   5. only a Dockerfile / weak hint (fly/serverless/eas file w/o workflow) ⇒ best guess, LOW
 *   6. nothing                                 ⇒ unknown, NONE
 */
export function classifyEvidence(ev: DeliveryEvidence): DeliveryProposal {
  const verbs = ev.workflowDeployVerbs ?? [];
  const releaseScriptIsCutDmg =
    !!ev.releaseScript && /cut-dmg/i.test(ev.releaseScript);

  // 1) Release-tag shipping: a CI-cut GitHub Release, a cut-dmg release script, or a semver-tag
  //    convention. Highest confidence — these are git/GitHub signals we can verify directly.
  if (has(verbs, "gh release") || has(verbs, "action-gh-release")) {
    return releaseProposal(
      `Ships via a GitHub Release workflow (${matchedReleaseVerb(verbs)}).`,
    );
  }
  if (releaseScriptIsCutDmg) {
    return releaseProposal(
      `Ships via a release script (${ev.releaseScript}) that cuts a build/release.`,
    );
  }
  if (ev.hasSemverTags) {
    return releaseProposal(
      `Ships via semver release tags (${ev.tagCount} tag${ev.tagCount === 1 ? "" : "s"} like v*).`,
    );
  }

  // 2) CI deploy: a workflow that pushes straight to a hosting provider. High confidence — the
  //    deploy verb is right there in the workflow file.
  const ciVerb =
    (has(verbs, "vercel deploy") && "vercel deploy") ||
    (has(verbs, "fly deploy") && "fly deploy") ||
    (has(verbs, "eas submit") && "eas submit") ||
    (has(verbs, "docker push") && "docker push") ||
    null;
  if (ciVerb) {
    return {
      method: "ci_deploy",
      confidence: "high",
      note: `Ships via CI deploy (${ciVerb}${ev.workflowFiles.length ? ` in ${ev.workflowFiles[0]}` : ""}).`,
      // A CI deploy job's success isn't observable from our signal set — keep it manual (honest).
      criteria: deliveredCriteria("Deployed to prod by CI", null),
    };
  }

  // 3) Merge-is-deploy: a hosting-provider config file with NO deploy workflow ⇒ the provider
  //    auto-deploys the production branch. Medium — we can't watch the provider directly (honesty),
  //    so "merge to the default branch" is our best observable proxy.
  if (ev.hasVercel || ev.hasNetlify) {
    const provider = ev.hasVercel ? "Vercel" : "Netlify";
    return {
      method: "merge_is_deploy",
      confidence: "medium",
      note: `Likely auto-deploys to ${provider} on merge to the default branch (no deploy workflow found).`,
      // The merge to the default branch IS the deploy here — observable via `merged_to_main`.
      criteria: deliveredCriteria(`Merged & auto-deployed to ${provider}`, "merged_to_main"),
    };
  }

  // 4) Package publish: a publishable package + an `npm publish` verb in CI.
  if (ev.npmPublishable && has(verbs, "npm publish")) {
    return {
      method: "package_publish",
      confidence: "medium",
      note: `Ships by publishing ${ev.packageName ?? "the package"} to a package registry (npm publish).`,
      // A registry publish isn't observable from our signal set — keep it manual (honest).
      criteria: deliveredCriteria("Published to the registry", null),
    };
  }

  // 5) Weak hint: a Dockerfile or a provider/mobile config file with no workflow. Best guess, LOW —
  //    flagged clearly so the UI can invite the user to confirm or correct.
  if (ev.hasDockerfile || ev.hasFly || ev.hasServerless || ev.hasEas) {
    const hint = ev.hasFly
      ? "a fly.toml"
      : ev.hasEas
        ? "an Expo/EAS config"
        : ev.hasServerless
          ? "a serverless.yml"
          : "a Dockerfile";
    return {
      method: "ci_deploy",
      confidence: "low",
      note: `Found ${hint} but no deploy workflow — best guess is a CI/container deploy. Please confirm or correct.`,
      // Low-confidence guess; not observable — manual.
      criteria: deliveredCriteria("Deployed to prod verified", null),
    };
  }

  // 6) Nothing observable. HONEST: say we can't tell, and fall back to a single manual criterion.
  return {
    method: "unknown",
    confidence: "none",
    note: "Couldn't map how this project ships to production — tell Sparkle, or tick Delivered manually.",
    criteria: [{ text: "Deployed to prod verified", kind: "manual" }],
  };
}

function matchedReleaseVerb(verbs: string[]): string {
  if (has(verbs, "gh release")) return "gh release";
  if (has(verbs, "action-gh-release")) return "action-gh-release";
  return "release";
}

function releaseProposal(note: string): DeliveryProposal {
  return {
    method: "release_tag",
    confidence: "high",
    note,
    criteria: deliveredCriteria("Commit is in a cut release", IN_RELEASE_SIGNAL),
  };
}

/** Delivered criteria for a detected method. `signal` is the auto-signal Sparkle can actually
 *  OBSERVE for this method, or `null` when delivery isn't observable from our signal set — in which
 *  case the criterion is MANUAL (honesty: never seed an auto criterion that can never be satisfied).
 *  Only `release_tag` (→`in_release`) and `merge_is_deploy` (→`merged_to_main`, since the merge IS
 *  the deploy) are observable today; a CI deploy's success and a package publish are not, so they
 *  stay manual until the monitor grows those signals. */
function deliveredCriteria(text: string, signal: AutoSignal | null): StageCriterion[] {
  if (signal) {
    return [
      { text, kind: "auto", signal },
      { text: "Deployed to prod verified", kind: "manual" },
    ];
  }
  return [{ text, kind: "manual" }];
}

/**
 * Full detection: gather evidence via Rust, classify deterministically, then OPTIONALLY enrich the
 * human-readable note + criteria text via a single Haiku call. The Haiku pass is strictly cosmetic:
 * it may not change `method` and may not raise `confidence` above the heuristic's value. Any Haiku
 * failure falls back to the heuristic-only proposal (behind try/catch).
 *
 * @param projectRoot absolute repo path
 * @param opts.enrich set false to skip the Haiku pass entirely (pure heuristic; used by tests)
 */
export async function detectDelivery(
  projectRoot: string,
  opts: { enrich?: boolean } = {},
): Promise<DeliveryProposal> {
  const evidence = await invoke<DeliveryEvidence>("collect_delivery_evidence", {
    projectRoot,
  });
  const base = classifyEvidence(evidence);

  // For `none`/`unknown` there's nothing to enrich — keep the honest fallback verbatim.
  if (opts.enrich === false || base.method === "unknown") return base;

  try {
    const enriched = await enrichWithHaiku(evidence, base);
    return enriched;
  } catch {
    // Haiku is best-effort polish; never let it block or degrade the deterministic result.
    return base;
  }
}

const ENRICH_SYSTEM = [
  "You refine a delivery-detection proposal for a software project.",
  "You are given (1) repo-local EVIDENCE and (2) a DETERMINISTIC proposal already classified from",
  "that evidence. You MUST NOT change the `method`, raise `confidence`, or change how many criteria",
  "there are or whether each is auto/manual — those are FIXED. You may ONLY improve wording: the",
  "one-sentence `note` and each criterion's `text` (return criteria in the SAME order).",
  "Never invent a delivery method the evidence doesn't justify. Respond as JSON:",
  '{"note": string, "criteria": [{"text": string}]}',
].join("\n");

/** One Haiku turn that may rewrite `note`/`criteria` text only. Confidence + method are re-pinned
 *  from `base` afterwards so the model can never upgrade them. */
async function enrichWithHaiku(
  evidence: DeliveryEvidence,
  base: DeliveryProposal,
): Promise<DeliveryProposal> {
  const user = JSON.stringify({
    evidence,
    proposal: { method: base.method, confidence: base.confidence, note: base.note, criteria: base.criteria },
  });
  const out = await structuredJson<{ note?: string; criteria?: StageCriterion[] }>(
    ENRICH_SYSTEM,
    user,
    undefined,
    "Checking delivery criteria",
  );
  const note = typeof out.note === "string" && out.note.trim() ? out.note.trim() : base.note;
  const criteria = overlayCriteriaText(base.criteria, out.criteria);
  // Re-pin method + confidence from the deterministic base — Haiku CANNOT move these.
  return { method: base.method, confidence: base.confidence, note, criteria };
}

/** Haiku may only polish the WORDING of criteria — never their kind/signal or count, which are
 *  fixed by the deterministic method mapping (that's what keeps `in_release` reserved for release
 *  shipping and non-observable methods manual). Overlay Haiku's `text` onto the base criteria by
 *  index; every structural field comes from `base`. */
function overlayCriteriaText(base: StageCriterion[], raw: unknown): StageCriterion[] {
  if (!Array.isArray(raw)) return base;
  return base.map((crit, i) => {
    const r = raw[i];
    const text =
      r && typeof r === "object" && typeof (r as Record<string, unknown>).text === "string"
        ? ((r as Record<string, unknown>).text as string).trim()
        : "";
    return text ? { ...crit, text } : crit;
  });
}

// Re-pin guard is exercised implicitly; expose the rank map for any downstream assertion.
export const _CONFIDENCE_RANK = CONFIDENCE_RANK;
