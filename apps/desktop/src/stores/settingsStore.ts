// settingsStore — app-level integration settings that aren't tied to a single project.
// Currently: the Chief (Storytell) Personal Access Token used by Think agents, plus the
// mapping from a Sparkle project id -> the Chief project id we auto-created for it. Persisted
// to localStorage like the other stores.
//
// NOTE: the user-entered PAT is written to the OS keychain on save (Rust chief_pat_secure_*) and
// read keychain-first via keychainChiefPat (seeded at launch by services/chief). A legacy
// localStorage chiefPat remains a READ-ONLY fallback; scrubbing/migrating that copy is deferred to
// a follow-up bead, so chiefPat is still persisted here to keep that fallback readable.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AgentTabStatus } from "../types";
// Type-only import: erased at compile time, so the store stays free of the Tauri runtime dep
// (services/config pulls in @tauri-apps) and remains testable under jsdom.
import type { ConcurrencyBound, EffectiveConfig } from "../services/config";
// Type-only for the same reason as EffectiveConfig above: services/displaySpan imports
// @tauri-apps, and this store must stay loadable under jsdom.
import type { SpanMode } from "../services/displaySpan";
// TYPE + CONSTANT ONLY. The union lives beside the persona fragment it governs
// (`services/buildAgent`), so the values this store coerces to and the prose that switches on them
// cannot drift; `DEFAULT_PREVIEW_EAGERNESS` is a plain const, so this pulls in no component code.
import { DEFAULT_PREVIEW_EAGERNESS, type PreviewEagerness } from "../services/buildAgent";
// Type-only for a SECOND reason on top of the Tauri one above: policy.ts imports the concierge tool
// domains, and services/conciergeTools/lifecycle.ts imports THIS store. A value import would close
// that loop; `import type` is erased, so it can't.
import type { PolicyDecision, ToolPolicyOverrides } from "../services/conciergeTools/policy";
import {
  toApprovalMap,
  asResumeRule,
  asConciergeAnswers,
  DEFAULT_RESUME_RULE,
  DEFAULT_CONCIERGE_ANSWERS,
  type ApprovalCategory,
  type ApprovalMap,
  type ApprovalRule,
  type ResumeRule,
} from "../services/suggestions/approvalCategories";

// --- Status-change notifications -------------------------------------------------------------
// Which agent statuses fire a Notification Center banner when an agent crosses INTO them. The
// user picks these via the "Notifications" section of the ⋯ menu. Defaults: the red tier
// (waiting/approval/errored) plus the "finished" tier (idle = your turn, done) — i.e. tell me
// when an agent needs me OR is done. The dock badge is separate (always waiting/approval).
//
// Why `idle` is ON but `working` is OFF, even though both can flip often for loop-style agents:
// `idle` is the "I'm done, your turn" edge the user explicitly asked to be notified about (most
// interactive agents finish a turn as idle, not done), so it earns a ping; `working` is pure
// churn (start of every turn/tool) with no actionable signal. Both are one toggle away if the
// default is wrong for a given workflow. blocked/stopped are passive and default OFF too.
export const DEFAULT_NOTIFY_STATUSES: Record<AgentTabStatus, boolean> = {
  waiting: true,
  approval: true,
  errored: true,
  // ON by default, with the red asks — `questions` is BLUE but it is not passive. An agent that
  // has stopped to ask something is losing time until the founder answers, exactly like `waiting`,
  // and the founder's ask was that this be as impossible to miss as the blocked pill. The colour is
  // what differs, not the loudness. (Contrast `blocked`/`unmerged` below, which really are "when
  // you get to it" and stay off.)
  questions: true,
  idle: true,
  done: true,
  working: false,
  blocked: false,
  // OFF, and for the same reason `blocked` is: this is a "when you get to it" state, not an ask.
  // It is the whole point of the amber tier — the founder spent a day triaging rows that needed
  // nothing, so a state meaning "auto-continue stopped and nothing is waiting on you" must not
  // arrive as a banner. One toggle away for anyone who wants it.
  lapsed: false,
  // `unmerged` floats the row above the calm tier but is GRAY, not red (see packages/ui/tokens.ts),
  // and does NOT ping by default — a finished agent's un-merged branch is a passive "when you get to
  // it" nudge, not a banner-worthy event.
  unmerged: false,
  // `new` (spawned, never briefed) must NEVER ping by default. It is the absence of an ask: the
  // agent has not asked for anything, so a banner would be the app telling the user about their own
  // un-actioned intent. This default is the notification half of the false-"needs you" fix — the
  // colour half is the GRAY token (packages/ui/tokens.ts) and the derivation is
  // engine/newAgentAttention.ts. Still a toggle, for anyone who wants the reminder.
  new: false,
  stopped: false,
};

// --- AI features (gated by the "Use AI Features" control in the ⋯ menu) ----------------------
// Independent on/off feature flags plus a derived All|Some|Off mode. Each feature degrades to a
// non-AI baseline when off (on-device dictation, no auto-rename, bare terminal instead of the
// composer). Default ON so the app is fully featured out of the box.

/** Stable identifiers for the AI features, used by the menu + the generic setter. */
export type AiFeatureKey =
  | "autoRename"
  | "voiceDictation"
  | "composer"
  | "suggestedActions"
  | "autoApprove"
  /** The concierge column: its brain (a `claude -p` turn) and its whole tool surface. */
  | "concierge";

/** Derived state of the master segment: every feature on / off / a mix. */
export type AiMode = "all" | "some" | "off";

/** The subset of settings state that the AI-features mode is derived from. */
export interface AiFeatureFlags {
  aiAutoRename: boolean;
  /** The voice-dictation feature is the existing cloud-dictation flag (Deepgram on/off). */
  cloudDictation: boolean;
  aiComposer: boolean;
  aiSuggestedActions: boolean;
  /** Sparkle Auto-Approve master toggle (nudging + auto-answering permission prompts). */
  aiAutoApprove: boolean;
  /** The concierge column. Gates BOTH halves that cost money: the `claude -p` turn behind the
   *  chat, and every tool it can drive. The column's status readout is derived from local state
   *  and stays on — see ConciergeColumn. */
  aiConcierge: boolean;
}

/** Map a menu feature key to its settings-store field name. The single source of this
 *  mapping — `aiGate` imports it so the key→field relationship is never duplicated. */
export const AI_FEATURE_FIELD: Record<AiFeatureKey, keyof AiFeatureFlags> = {
  autoRename: "aiAutoRename",
  voiceDictation: "cloudDictation",
  composer: "aiComposer",
  suggestedActions: "aiSuggestedActions",
  autoApprove: "aiAutoApprove",
  concierge: "aiConcierge",
};

// --- Tools (the opinionated [tools] flags, surfaced in the ⋯ Settings → "Tools" pane) ---------
// Non-AI, config-backed on/off tools. Each defaults ON; off means the tool is used nowhere in
// Sparkle (analytics stops sending, the Beads board hides, GitHub import is hidden). Like the
// workflow-mirror fields these are hydrated from config.toml and NOT persisted to localStorage.

/** Stable identifiers for the config-backed [tools] flags. */
export type ToolKey =
  | "analytics"
  | "beads"
  | "github"
  | "guardrails"
  | "roborev"
  | "onepassword"
  | "builderIndex"
  | "straude";

/** Map a tool key to its settings-store field name (the single source of that relationship). */
export const TOOL_FIELD: Record<
  ToolKey,
  | "analyticsEnabled"
  | "beadsEnabled"
  | "githubEnabled"
  | "guardrailsEnabled"
  | "roborevEnabled"
  | "onepasswordEnabled"
  | "builderIndexEnabled"
  | "straudeEnabled"
> = {
  analytics: "analyticsEnabled",
  beads: "beadsEnabled",
  github: "githubEnabled",
  guardrails: "guardrailsEnabled",
  roborev: "roborevEnabled",
  onepassword: "onepasswordEnabled",
  builderIndex: "builderIndexEnabled",
  straude: "straudeEnabled",
};

// --- Plugins (the [plugins] flags — Claude Code plugins pre-enabled for every agent) ----------
// Kept as their OWN key space rather than folded into ToolKey: they persist to a different config
// section ([plugins], repo-overridable) than [tools] (machine-wide), so a single key type would
// make the wrong dotted path reachable. Same shape and same hydrate/optimistic-write pattern.

/** Stable identifiers for the config-backed [plugins] flags.
 *
 *  The `sparkle*` ones come from Sparkle's OWN public marketplace
 *  (github.com/try-sparkle/marketplace, Apache-2.0) rather than Anthropic's official one — the
 *  same opinions Sparkle applies internally, published so they can be read, forked, or used
 *  without Sparkle. */
export type PluginKey =
  | "superpowers"
  | "frontendDesign"
  | "sparkleGuardrails"
  | "sparkleFreshness"
  | "sparkleMutationCheck"
  | "sparkleConflictWatch"
  | "sparkleSecrets"
  | "sparkleReviewProbes"
  | "sparklePusher";

/** Defaults, mirroring the `default_on` column of Rust's `KNOWN_PLUGINS`. Used until the first
 *  config hydrate answers for real.
 *
 *  THE TWO MUST FLIP IN THE SAME COMMIT. This comment used to say a disagreement here was "a
 *  first-paint flicker, not a correctness bug, because Rust is the authority" — which read as
 *  licence to defer the mirror update, and is how all four sparkle* rows below sat at `true` for a
 *  commit after the Rust table moved them to `false`. Two things make it wrong: the flicker is
 *  user-visible (the toggle paints the wrong state until hydrate lands, which on a slow start is
 *  long enough to read and click), and it is now a hard `cargo test` failure —
 *  `the_frontend_plugin_defaults_mirror_matches_this_tables_default_on_column` in `config.rs` reads
 *  THIS FILE from disk and compares it to `KNOWN_PLUGINS` row for row, in both directions. */
export const PLUGIN_DEFAULTS: Record<PluginKey, boolean> = {
  superpowers: true,
  frontendDesign: true,
  // OFF: [tools].guardrails already injects this same prose (see the Rust table).
  sparkleGuardrails: false,
  sparkleFreshness: true,
  // A deliberate, targeted act ("prove THIS test can fail"), not a background discipline.
  sparkleMutationCheck: false,
  // The four below ship OFF, and — unlike the two above — not on their own merits: each earns an
  // eventual ON, but try-sparkle/marketplace does not carry the content yet, so an enabled row
  // makes the install pass retry a failing `claude plugin install` on every launch and renders a
  // "couldn't install" hint. They flip to true once each name appears in that listing, in the same
  // commit that flips Rust's `default_on`. See the KNOWN_PLUGINS block in config.rs.
  sparkleConflictWatch: false,
  sparkleSecrets: false,
  sparkleReviewProbes: false,
  sparklePusher: false,
};

// --- Chief sync state (replacing the legacy markdown-sync watermark) -----------------------

/** Per-path Chief sync state: a content hash + the asset id currently holding that content. */
export interface ChiefDocState {
  hash: string;
  assetId: string;
}

/** The ONE rule for a 1Password vault id: trimmed, and blank-or-absent means "no vault picked".
 *
 *  Every write path into `onepasswordVaultId` goes through this — the store setter, the config
 *  hydrator, and the configActions writer — because the bug this replaced was three
 *  near-identical copies where one of them (hydration) quietly didn't trim. A truthy-but-blank id
 *  reads as "configured" to every downstream check and makes each `op` call fail opaquely. */
export function normalizeVaultId(vaultId: string | null | undefined): string | null {
  return vaultId?.trim() || null;
}

/** The chosen 1Password ACCOUNT id, under the same rule and for a sharper reason: a blank
 *  `account_id` would be passed to `op` as `--account ""` on every single invocation, failing
 *  everything instead of degrading to "no account chosen". Same function, named for the caller so
 *  neither site has to know they share a rule. */
export const normalizeAccountId = normalizeVaultId;

/** Narrow a raw `[concierge.tools]` payload into the store's mirror: drop non-string values, keep
 *  every string VERBATIM.
 *
 *  A structural twin of services/conciergeTools/policy.ts's `toToolPolicyOverrides`, and it is a
 *  copy for a reason worth stating rather than a duplication to clean up: policy.ts imports the four
 *  concierge tool domains, and one of them (lifecycle.ts) imports THIS store — so a value import
 *  would close an import cycle. The type is still shared (`import type` above, which is erased), and
 *  settingsStore.test.ts asserts the two agree on every input, so the copy cannot drift silently.
 *
 *  Values are NOT validated here: an unrecognized rule must survive to `evaluateToolPolicy`, which
 *  reads it as "ask". Dropping it would restore the tool's (possibly permissive) default. */
export function toConciergeToolPolicy(raw: unknown): ToolPolicyOverrides {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Narrow `[concierge].own_orgs` into the store's mirror: strings only, trimmed and LOWERCASED,
 *  blanks dropped, order preserved.
 *
 *  Lowercased HERE rather than at each comparison because GitHub treats owners case-insensitively
 *  and the alternative is every reader remembering to. Dropping a non-string is safe in a way that
 *  dropping a tool RULE is not: an org that is not in this list is FOREIGN, which is the stricter
 *  answer, so a garbage entry costs an extra approval rather than a silent grant. */
export function toConciergeOwnOrgs(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw as unknown[]) {
    if (typeof value !== "string") continue;
    const org = value.trim().toLowerCase();
    if (org.length > 0 && !out.includes(org)) out.push(org);
  }
  return out;
}

/** Narrow `[concierge.projects]` into the store's mirror: `slug -> { tool -> rule }`, slugs
 *  lowercased, non-string RULE VALUES KEPT OUT but unrecognized ones kept VERBATIM.
 *
 *  Same discipline as `toConciergeToolPolicy` and for the same reason: `evaluateToolPolicy` reads
 *  an unrecognized rule as `ask` — stricter than absent — so narrowing it away here would erase the
 *  difference between "the user typo'd a project rule" and "the user set none", handing back the
 *  looser global answer on exactly the repo they were tightening. */
export function toConciergeProjectPolicy(
  raw: unknown,
): Readonly<Record<string, ToolPolicyOverrides>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ToolPolicyOverrides> = {};
  for (const [slug, entry] of Object.entries(raw as Record<string, unknown>)) {
    const key = slug.trim().toLowerCase();
    if (key.length === 0) continue;
    // `{ tools = { … } }` is the shape Rust sends; a project whose table exists but is empty (or
    // whose `tools` is null, which is how a Rust Option arrives) is a real entry with no rules.
    const tools =
      entry && typeof entry === "object" ? (entry as { tools?: unknown }).tools : undefined;
    out[key] = toConciergeToolPolicy(tools);
  }
  return out;
}

/** Derive the master segment from the four flags: all on → "all", all off → "off", else "some". */
export function aiFeatureMode(f: AiFeatureFlags): AiMode {
  const vals = [
    f.aiAutoRename,
    f.cloudDictation,
    f.aiComposer,
    f.aiSuggestedActions,
    f.aiAutoApprove,
    f.aiConcierge,
  ];
  if (vals.every(Boolean)) return "all";
  if (vals.every((v) => !v)) return "off";
  return "some";
}

/**
 * Persist migrations, applied in order against the stored `version`:
 *  - v0 → v1: the binary `aiEnabled` master became four per-feature flags (all default on).
 *    Without this, a user who set `aiEnabled=false` (to stop AI work and avoid consuming credits)
 *    would silently get every AI feature — including the billable cloud-dictation path — re-enabled
 *    on upgrade. Map a stored `aiEnabled===false` to all four flags off; absent/true lets the
 *    on-by-default values win.
 *  - v1 → v2: `autoApplyUpdates` was added (default on). An existing install has no stored value,
 *    so set it to `true` explicitly here — the same default a fresh install gets — rather than
 *    relying on merge alone, so the migrated shape is self-describing.
 *  - v2 → v3: `lastSeenChangelogVersion` was added (the in-app What's New panel). An existing
 *    install has no record of what it was running, and there is no honest way to invent one — so it
 *    migrates to an EXPLICIT null, which WhatsNewPanel reads as "first run": seed it to the version
 *    now running and show only that release. Anything else would dump the whole backlog at a user
 *    on their next launch. The auto-open then fires on the release AFTER this one, which is the
 *    first transition the app can actually observe.
 * Pure + exported for testing.
 */
export function migrateSettings(persisted: unknown, version: number): unknown {
  let prev = persisted as
    | (Partial<AiFeatureFlags> & {
        aiEnabled?: boolean;
        autoApplyUpdates?: boolean;
        lastSeenChangelogVersion?: string | null;
      })
    | null
    | undefined;
  if (version < 1 && prev && prev.aiEnabled === false) {
    prev = {
      ...prev,
      aiAutoRename: false,
      cloudDictation: false,
      aiComposer: false,
    };
  }
  if (version < 2 && prev && prev.autoApplyUpdates === undefined) {
    prev = { ...prev, autoApplyUpdates: true };
  }
  if (version < 3 && prev && prev.lastSeenChangelogVersion === undefined) {
    prev = { ...prev, lastSeenChangelogVersion: null };
  }
  return prev;
}

// Build-time fallback PAT injected by vite.config from the user's CHIEF_API env (dev only; see
// vite.config.ts). Empty in production builds. The primary env path is now the RUNTIME one below
// (`runtimeChiefPat`), resolved by the Rust `chief_pat` command from the user's .env.local at
// launch — that works in packaged builds too and never bakes the secret into the bundle.
const BUILD_ENV_CHIEF_PAT = ((import.meta.env.VITE_CHIEF_PAT as string | undefined) ?? "").trim();

/**
 * The PAT to actually use, in priority order: the OS-keychain value (keychainChiefPat, seeded at
 * launch), then the legacy user-entered localStorage value (stored), then the runtime env-resolved
 * one (Rust chief_pat), then the dev build-time fallback.
 */
export function effectiveChiefPat(keychain: string, stored: string, runtime = ""): string {
  return keychain.trim() || stored.trim() || runtime.trim() || BUILD_ENV_CHIEF_PAT;
}

/**
 * Which OTHER Sparkle project already syncs into `chiefProjectId`, if any.
 *
 * Exported so the picker can mark those options rather than letting the store refuse a choice the
 * UI presented as available — a silent no-op is the worst of both.
 *
 * `liveProjectIds` is REQUIRED, and passing the wrong thing here is the whole bug this parameter
 * exists to prevent. `chiefProjectByProject` is persisted and is NOT pruned by every path that can
 * destroy a project, so it accumulates entries for projects that no longer exist. Counting one of
 * those as an owner makes a ghost claim its library FOREVER: closing a project and re-adding the
 * same folder mints a new id, `ensureChiefProject` name-matches back onto the old library, and the
 * claim check then refuses every sync against an owner the UI cannot even name — with no in-app
 * remedy, because the picker disables the option too. Ownership is only meaningful for a project
 * that still exists.
 */
export function chiefLibraryOwner(
  links: Record<string, string>,
  chiefProjectId: string,
  exceptSparkleProjectId: string,
  liveProjectIds: Iterable<string>,
): string | null {
  const live = liveProjectIds instanceof Set ? liveProjectIds : new Set(liveProjectIds);
  for (const [sparkleId, chiefId] of Object.entries(links)) {
    if (chiefId !== chiefProjectId) continue;
    if (sparkleId === exceptSparkleProjectId) continue;
    if (!live.has(sparkleId)) continue; // ghost link from a removed project — owns nothing
    return sparkleId;
  }
  return null;
}

function isChiefLibraryClaimed(
  links: Record<string, string>,
  chiefProjectId: string,
  exceptSparkleProjectId: string,
  liveProjectIds: Iterable<string>,
): boolean {
  return chiefLibraryOwner(links, chiefProjectId, exceptSparkleProjectId, liveProjectIds) !== null;
}

/**
 * Drop `previous`'s ledger ONLY when no other Sparkle project still syncs into it.
 *
 * The ledger is keyed by CHIEF project id, so it is shared state whenever two Sparkle projects
 * point at one library. Deleting it unconditionally when one of them moves away destroys the
 * record the OTHER is still using: its next sync loses every recorded `assetId`, so its stale docs
 * can never be deleted (orphans linger forever) and it re-uploads its whole tree. `relinkChiefProject`
 * now refuses to create that sharing in the first place, but persisted state from before this
 * guard can already contain it, so the drop has to be conditional regardless.
 */
function dropLedgerIfUnused(
  s: { chiefProjectByProject: Record<string, string>; chiefDocStateByProject: Record<string, Record<string, ChiefDocState>> },
  movingSparkleProjectId: string,
  previous: string | undefined,
  liveProjectIds: Iterable<string>,
): Record<string, Record<string, ChiefDocState>> {
  if (!previous) return s.chiefDocStateByProject;
  if (isChiefLibraryClaimed(s.chiefProjectByProject, previous, movingSparkleProjectId, liveProjectIds)) {
    return s.chiefDocStateByProject; // someone else still needs it
  }
  const { [previous]: _dropped, ...rest } = s.chiefDocStateByProject;
  return rest;
}

/**
 * The worker-concurrency limit to actually enforce: the MIN of what the user configured and what
 * this machine's RAM can hold. Both are ceilings — neither may raise the other — so taking the min
 * is correct in every ordering, including before the first hydrate lands.
 *
 * Every concurrency gate must read this rather than `maxConcurrentWorkers` directly. Spawning to
 * the raw configured number is what let 24 agents × ~4 GiB of V8 heap exhaust a Mac's RAM and get
 * system daemons jetsam-killed (sparkle-01xv / sparkle-asz5).
 */
export function enforcedWorkerCap(s: {
  maxConcurrentWorkers: number;
  effectiveMaxConcurrentWorkers: number;
}): number {
  return Math.max(1, Math.min(s.maxConcurrentWorkers, s.effectiveMaxConcurrentWorkers));
}

/**
 * The sentence to show a human when the ceiling is the thing standing in their way, e.g.
 * `"CPU-bound: 18 cores × 2 agents per core"` or `"pinned to 32 in config.toml…"`.
 *
 * Composed in Rust next to the number it explains (`EffectiveConfig.concurrency_basis`) so the two
 * cannot drift. This reads it back rather than re-deriving anything, because every attempt to
 * re-derive the cause from the value has been wrong: the concierge's refusal asserted "derived from
 * installed RAM" unconditionally on a machine that was CPU-bound at 36 and pinned at 32.
 *
 * The fallback is deliberately CAUSELESS, not a guess: an older backend that sends no basis gets a
 * sentence that states the number and nothing about why. Saying nothing beats naming the wrong
 * dimension — that is the whole bug this field exists to close.
 */
export function concurrencyBasis(s: {
  concurrencyBasis: string;
  effectiveMaxConcurrentWorkers: number;
  maxConcurrentWorkers: number;
}): string {
  return s.concurrencyBasis.trim() || `${enforcedWorkerCap(s)} at once on this machine`;
}

// --- Sparkle self-improvement consent --------------------------------------------------------
// How the built-in Sparkle improvement agent may act on the user's anonymous logs. This gates the
// hourly log evaluation and whether improvement PRs are auto-submitted to the OSS project:
//   - "always"       → evaluate hourly AND auto-submit scrubbed PRs (only if the privacy scan passes).
//   - "case_by_case" → evaluate hourly and craft PRs, but the user reviews + approves each before submit.
//   - "never"        → do not evaluate logs at all.
// Default is the privacy-conservative "case_by_case": no PR leaves the machine without explicit
// per-PR approval. Note this governs PRs only — it is NOT a blanket "nothing is transmitted" claim.
// Crash reports are gated separately in crash.rs (`upload_allowed`/`logs_allowed`): "case_by_case"
// uploads the scrubbed crash report (message + backtrace, no log tail) without per-crash approval,
// and only "always" adds the ~200KB recent-logs tail. See SparkleConsentBanner's `consentCopy`,
// which states this per mode — that copy and the Rust gate must not drift apart (they once did:
// the gate required "always" while the default was "case_by_case", so crash reports were captured
// but NEVER uploaded, and the crash table sat empty while real crashes went undiagnosed).
// The default lives here (not behind a migration) — the store's `merge` makes any
// pre-existing persisted blob that lacks this field inherit this default on read.
export type SparkleImprovementConsent = "always" | "case_by_case" | "never";

/** The default consent mode for a fresh install: review-and-approve each PR. */
export const DEFAULT_SPARKLE_CONSENT: SparkleImprovementConsent = "case_by_case";


/**
 * Coerce `[preview] agent_eagerness` into the union, FAILING CLOSED to the shipped default.
 *
 * The union itself lives in `services/buildAgent` beside the fragment it governs, so the prose and
 * the values it switches on cannot drift apart. Fails closed TOWARDS `"visual"` rather than towards
 * `"never"`: an unreadable value must not be able to silently switch the whole feature off, which is
 * the failure — previews never happening, with nothing logged — that this knob exists to end.
 */
export function asPreviewEagerness(value: unknown): PreviewEagerness {
  return value === "visual" || value === "always" || value === "never"
    ? value
    : DEFAULT_PREVIEW_EAGERNESS;
}

/** Bead cards render OPEN by default (`[ui].bead_cards_expanded`). The founder's call — see
 *  `beadCardsExpanded` below and `BeadPill.tsx`. Flipping this one constant, or the TOML key it
 *  mirrors, is the entire revert. */
export const DEFAULT_BEAD_CARDS_EXPANDED = true;

/** No cap on how many cards one reply expands (`[ui].bead_cards_expanded_max`).
 *
 *  ZERO IS A DELIBERATE CHOICE, NOT AN UNSET SENTINEL WE NEVER GOT AROUND TO PICKING. A cap of 3
 *  was offered and the founder chose uncapped: he would rather meet the ceiling in real use and
 *  dial it down than have a number guessed for him. The cap machinery is built and tested so that
 *  dialling down is one TOML key, not a code change. */
export const DEFAULT_BEAD_CARDS_EXPANDED_MAX = 0;

/**
 * Coerce `[ui].bead_cards_expanded_max` into a usable cap: a non-negative integer, or the default
 * when the key is absent.
 *
 * DEFENDS AGAINST A HAND-EDITED FILE, which is the only kind this key ever has. Rust forwards what
 * TOML parsed rather than a corrected value, so a negative or fractional number reaches here — and
 * an unguarded negative is the dangerous one: every `index < max` test is then false, so NO card
 * expands and the symptom is indistinguishable from the feature having been turned off. Rounding
 * DOWN (rather than to nearest) keeps `2.9` from quietly behaving as a cap of 3.
 */
export function normalizeBeadCardsExpandedMax(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BEAD_CARDS_EXPANDED_MAX;
  return Math.max(0, Math.floor(value));
}

interface SettingsState {
  /** Legacy user-entered Chief PAT (begins with `pat_`), persisted in localStorage. Kept as a
   *  READ-ONLY fallback; the OS keychain value (keychainChiefPat) is preferred. */
  chiefPat: string;
  /** The Chief PAT read from the OS keychain at launch (Rust chief_pat_secure_get). The keychain is
   *  the store of record, so this is NOT persisted; it is preferred over the legacy localStorage
   *  value. Written by saveChiefPat and cleared by disconnectChiefPat (services/chief). */
  keychainChiefPat: string;
  /** PAT the Rust backend resolved from env / .env.local at launch. Not persisted — re-resolved
   *  fresh each session (the env token can rotate). Used as a fallback when none is stored. */
  runtimeChiefPat: string;
  /** sparkleProjectId -> chiefProjectId (the Chief project we created/linked for it). */
  chiefProjectByProject: Record<string, string>;
  /** chiefProjectId -> (doc path -> { content hash, asset id }). The current-state sync ledger:
   *  one entry per path, replaced wholesale each sync. */
  chiefDocStateByProject: Record<string, Record<string, ChiefDocState>>;
  /** Maximum number of concurrent workers on THIS MACHINE, across every orchestrator (floored at 1,
   *  otherwise unbounded). Adjustable via the slider in the ⋯ menu; the orchestration persona reads
   *  this same value so the cap it's told about always matches.
   *
   *  Machine-wide, not per build agent — ratified 2026-07-30 (bead `sparkle-axtkw`). The doc said
   *  "per build agent" while the gate that enforces it counted machine-wide; one key cannot carry
   *  both dimensions, and a per-agent limit would need its own. */
  maxConcurrentWorkers: number;
  /** The concurrency the app actually ENFORCES: what the MACHINE can carry, computed in Rust as
   *  `min(RAM-derived, cores × AGENTS_PER_CORE)` — see `EffectiveConfig.effective_max_concurrent`.
   *  Cores bind as often as RAM does (an agent runs git, builds and test suites), so this is not a
   *  memory-only number. Always ≤ `maxConcurrentWorkers`, always ≥ 1.
   *
   *  Why it's separate from `maxConcurrentWorkers`: that one is the user's *request* and stays
   *  intact so the ⋯-menu slider keeps showing what they chose. This one is what the machine can
   *  survive. Spawning to the request instead of this is what let 24 agents × ~4 GiB of V8 heap
   *  exhaust a Mac's RAM and get system daemons jetsam-killed (sparkle-01xv / sparkle-asz5).
   *  Derived, never persisted — recomputed from config on every hydrate. */
  effectiveMaxConcurrentWorkers: number;
  /** What the MACHINE alone could carry, ignoring any `[workers].max_concurrent` pin. Equal to
   *  `effectiveMaxConcurrentWorkers` under AUTO. Kept so the UI can say "you pinned this" instead of
   *  "your Mac is full" — the remedy for the first is a config line, not different hardware.
   *  Derived, never persisted. */
  machineMaxConcurrentWorkers: number;
  /** Which dimension binds the enforced ceiling: cpu | ram | both | pinned | unknown. Mirrored from
   *  Rust's `Bound`, whose entire documented purpose is to stop the app mis-attributing the limit —
   *  an attribution that existed in Rust for months without ever reaching a human. Derived, never
   *  persisted. */
  concurrencyBound: ConcurrencyBound;
  /** The ready-to-show sentence for that dimension, with its arithmetic. Read it via
   *  `concurrencyBasis()` rather than directly, so an older backend's empty value degrades to a
   *  causeless sentence instead of a wrong one. Derived, never persisted. */
  concurrencyBasis: string;
  /** Use the cloud streaming STT (Deepgram Nova-3) for active dictation when available. Default
   *  on — the gold-standard path. Falls back to the on-device model automatically when off, when
   *  no key is present, or when offline. The on-device model is the always-available local path
   *  either way — nothing about the send tray changes when this is off, only which engine decodes.
   *  This is also AI feature "voiceDictation" in the Use AI Features menu. */
  cloudDictation: boolean;
  /** Auto-name worker agents from their first prompt (the generate_agent_name call). Off → agents
   *  keep their default names. */
  aiAutoRename: boolean;
  /** Use the AI-enhanced composer (ghost text, screenshot drop, dictation insert, Send). Off →
   *  the composer is replaced by the bare terminal input. */
  aiComposer: boolean;
  /** Show one-click suggested action buttons in the composer (Haiku-learned actions). Off → only the free heuristic direct-answer buttons remain. */
  aiSuggestedActions: boolean;
  /** Sparkle Auto-Approve master toggle. On (default) → nudges + auto-answers matching Claude Code
   *  permission prompts per the [approvals] rules. Off → no nudging AND no auto-answering. Mirrors
   *  [ai].auto_approve. */
  aiAutoApprove: boolean;
  /** The concierge column's brain + tool surface. Off → the column still shows what needs the
   *  human (that readout is local state and costs nothing), but the chat and every tool are
   *  locked. Mirrors [ai].concierge. */
  aiConcierge: boolean;
  /** GLOBAL (all-projects) auto-approve rules, mirrored from config.toml's `[approvals]`. Per-project
   *  overrides live in approvalsStore (read via `get_config(root)`); this is the global layer used
   *  as the effective value when no project is in context and as the "all projects" scope in the
   *  approvals pane. Config-mirrored, NOT persisted. */
  approvals: ApprovalMap;
  /** GLOBAL (all-projects) session-resume rule, mirrored from config.toml's `[approvals].resume`.
   *  A SIBLING of `approvals` (own value domain — "ask"/"summary"/"full", not "always"/"never").
   *  Per-project overrides live in approvalsStore; this is the all-projects layer / the effective
   *  value when no project is in context. Config-mirrored, NOT persisted. */
  resumeRule: ResumeRule;
  /** GLOBAL (all-projects) concierge-routing flag, mirrored from config.toml's
   *  `[approvals].concierge_answers`. The second SIBLING of `approvals` with its own value domain
   *  (a plain boolean, not "always"/"never"): may a prompt the local classifier declines to answer
   *  be handed to the concierge, which reads it and answers?
   *
   *  NOT the same switch as `aiAutoApprove` above, on purpose. That one lets a purely local REGEX
   *  press buttons with nobody reading them; this one lets a reasoning agent read the question
   *  first. One switch for both would mean turning off the blind presser also silences the thing
   *  that reads. On by default — false sends every unclassified prompt to the human.
   *  Config-mirrored, NOT persisted. */
  conciergeAnswers: boolean;
  /** The concierge's explicit PER-TOOL autonomy rules, mirrored from config.toml's
   *  `[concierge.tools]`. Tool name → "allow" | "ask" | "deny", holding ONLY the rules the human
   *  set: a tool with no entry sits on the default derived from its risk class
   *  (services/conciergeTools/policy.ts), so an empty map is a complete policy, not an absent one.
   *
   *  Kept RAW (values unnarrowed) on purpose. `evaluateToolPolicy` reads an unrecognized value as
   *  "ask" — stricter than the derived default — and narrowing here would erase the difference
   *  between "the user typo'd a rule" and "the user set no rule", handing back the permissive
   *  default on exactly the rule they were tightening. Config-mirrored, NOT persisted. */
  conciergeToolPolicy: ToolPolicyOverrides;
  /** Has `hydrateFromConfig` run yet? Distinguishes "the human set no rules" from "we have not
   *  READ the human's rules", which the empty map alone cannot express (roborev 54247, finding 3).
   *  The difference matters: before the first hydrate, a tool the human explicitly set to `deny`
   *  is indistinguishable from one they never touched, so resolving through derived defaults would
   *  silently ignore their rule. Config-mirrored, NOT persisted — so it is false on every boot. */
  conciergeToolPolicyHydrated: boolean;
  /** `[concierge].own_orgs` — the orgs whose repos count as OURS, lowercased. Every other repo is
   *  FOREIGN, which floors anything touching its main branch at `ask`
   *  (services/conciergeTools/policy.ts). An EMPTY list makes every repo foreign, which is exactly
   *  today's global stopgap — so nobody gains anything on upgrade. Config-mirrored, NOT persisted;
   *  covered by `conciergeToolPolicyHydrated` (one read, one flag). */
  conciergeOwnOrgs: readonly string[];
  /** `[concierge.projects."<slug>".tools]` — per-project rules, keyed by LOWERCASED `owner/repo`.
   *  A project entry can only ever TIGHTEN the global tier above it. Kept RAW (values unnarrowed)
   *  for the same reason `conciergeToolPolicy` is. Config-mirrored, NOT persisted; covered by
   *  `conciergeToolPolicyHydrated`. */
  conciergeProjectPolicy: Readonly<Record<string, ToolPolicyOverrides>>;
  /** Auto-apply desktop updates: when on (default), a found update downloads + installs silently
   *  and applies on the next restart, with a quiet "ready" affordance. When off, the user gets a
   *  "Restart to apply / Later" prompt instead and nothing is installed until they choose. Read by
   *  updaterService. */
  autoApplyUpdates: boolean;
  /** Which rectangle "Span all displays" targets (Appearance → Window). "safe" (default) uses the
   *  largest fully-covered rectangle so no UI lands in a region no display shows; "full" uses the
   *  union bounding box, trading dead corners for area. Persisted — it's a UI preference, not a
   *  workflow rule, so it belongs here rather than in config.toml. */
  windowSpanMode: SpanMode;
  /** Re-apply the current span when a display is plugged in or unplugged (default on). This is a
   *  safety default more than a convenience one: unplugging while spanned otherwise leaves the
   *  window at a geometry no remaining display can show. Persisted. */
  windowAutoRespan: boolean;
  /** Is the window currently spanned across displays? Set when the user spans, cleared when they
   *  fit-to-display or reset.
   *
   *  UI-only and NEVER persisted, and both halves of that matter. It gates auto-respan, which must
   *  fire only for a window the user actually spanned — otherwise plugging in a monitor would
   *  stretch a window they had deliberately sized small. And not persisting it means a relaunch
   *  never silently re-spans; restoring a span across restarts was left out of scope. */
  windowIsSpanned: boolean;
  /** Which agent statuses fire a Notification Center banner on the transition INTO them. See
   *  DEFAULT_NOTIFY_STATUSES. Persisted; merged over the defaults on read so a status added later
   *  inherits its default rather than reading undefined. */
  notifyStatuses: Record<AgentTabStatus, boolean>;
  /** Consent for the Sparkle self-improvement agent to use the user's anonymous logs. See
   *  SparkleImprovementConsent. Persisted; defaults to "case_by_case". */
  sparkleImprovementConsent: SparkleImprovementConsent;
  /** Epoch ms of the last hourly improvement-pass ATTEMPT (recorded at pass start, success or
   *  not, so a failing setup retries next hour instead of hot-looping). null = never — the
   *  scheduler seeds it on its first tick, so the first pass lands ~1h after consent is active
   *  rather than the moment the app opens. Persisted (a restart must not reset the hour). */
  improvementLastRunAt: number | null;
  /** Opt-in for warming the Improve Sparkle pane at app launch (main window only), so the agent is
   *  already up when the user opens its row instead of cold-starting on click. Only consulted in
   *  "case_by_case" consent — "always" is standing authority and warms without asking, "never"
   *  never warms. null = not yet decided (treated as opt-out until the user ticks the box).
   *  Persisted. See sparkleAgent.shouldWarmSparkleAtLaunch — that gate, not this flag, is the
   *  single place the three modes are resolved. */
  improvementLaunchWarm: boolean | null;
  /** The app version whose "What's New" has already been shown to this user, e.g. "0.102.0".
   *
   *  null = nothing recorded (a fresh install, or an upgrade from before this key existed). The app
   *  had NO record of a previously-run version before this, which is why "what changed since the
   *  version you were on" was unanswerable — see WhatsNewPanel, which seeds this on first run and
   *  advances it each time it shows the panel. Persisted; a restart must not re-show the same
   *  release's What's New. */
  lastSeenChangelogVersion: string | null;

  // --- Editable config-file mirror (reflections of config.toml; the file is the source of truth) ---
  // Hydrated from the TOML config via `hydrateFromConfig` at startup and on every config-changed
  // event. NOT persisted to localStorage — re-read from the file each launch.
  /** true = open a PR & merge; false = allow pushing to the base branch directly. */
  requirePr: boolean;
  /** Each agent runs in its own isolated git worktree. */
  worktreeIsolation: boolean;
  /** Explicit base-branch override ("" = auto-detect from git). */
  defaultBranch: string;
  /** Cut each agent branch from a freshly-fetched base. */
  bornFreshFromBase: boolean;
  /** On closing a shipped build agent, safe-delete its now-merged branch (true) or keep it. */
  deleteMergedBranch: boolean;
  /** Drift-nudge thresholds: commits behind / ahead / changed lines. */
  driftBehindNudge: number;
  driftAheadNudge: number;
  driftChangedLines: number;
  /** Usage analytics + masked session replay (PostHog). Off → analytics.ts sends nothing. Mirrors
   *  [tools].analytics. Config-backed, NOT persisted — re-read from the file each launch. */
  analyticsEnabled: boolean;
  /**
   * How eagerly a build agent is TOLD to open a preview of its own work. Mirrors
   * `[preview] agent_eagerness`; config-backed, NOT persisted.
   *
   *   • `"visual"` (default) — the brief asks for a preview whenever the work changes something a
   *     person would look at.
   *   • `"always"` — ask on every task the project can preview at all.
   *   • `"never"` — the brief says nothing about previews; the manual affordances are untouched.
   *
   * Read at persona-composition time (`components/AgentPane`), not at render time — a change takes
   * effect for the next agent launched, not for one already running on the old brief.
   */
  previewEagerness: PreviewEagerness;
  /**
   * Render a bead card EXPANDED the moment the concierge names a bead, instead of as a pill the
   * reader clicks open. Mirrors `[ui].bead_cards_expanded`; config-backed, NOT persisted.
   *
   * The founder's ask, verbatim: "I wanna try changing things such that you show these bead cards
   * as expanded by default and of me having to click on them to expand them." `false` restores the
   * pre-2026-08 behaviour exactly, and is the whole revert — see `BeadPill.tsx`.
   */
  beadCardsExpanded: boolean;
  /**
   * How many cards ONE concierge reply may expand before the rest fall back to pills. `0` = no cap,
   * which is the shipped default. Mirrors `[ui].bead_cards_expanded_max`; config-backed, NOT
   * persisted.
   *
   * A COUNT rather than a boolean because the founder routinely lists eight or more beads in one
   * message and each expanded card runs several hundred pixels — the cap is the dial he reaches for
   * if the cards start pushing his own prose off screen. It counts only ids that RESOLVE; see
   * `BeadPill.tsx` for why spending it on id-shaped English would defeat the feature.
   */
  beadCardsExpandedMax: number;
  /** The in-repo work graph behind the Plan board (Beads / `bd`). Off → the board is hidden and no
   *  `bd` shell-out runs. Mirrors [tools].beads. */
  beadsEnabled: boolean;
  /** Import a project straight from GitHub. Off → the GitHub import path is hidden. Mirrors
   *  [tools].github. */
  githubEnabled: boolean;
  /** Opinionated quality guardrails for the code Sparkle's agents write. On (default) → the
   *  guardrails workflow (test-first, run tests+typecheck before commit, never call a red build
   *  "done") is appended to every coding agent's system prompt; off omits it. Mirrors
   *  [tools].guardrails. */
  guardrailsEnabled: boolean;
  /** roborev — the per-commit AI code-review daemon. On (default) → the Tools toggle is on and
   *  the daemon reviews each BUILD-agent commit; off → dormant. Mirrors [tools].roborev. Config-
   *  backed, NOT persisted — re-read from the file each launch. */
  roborevEnabled: boolean;
  /** Builder Index (tokenmaxxing leaderboard) reporting. Mirrors [tools].builder_index — the ONE
   *  tool that defaults OFF, because it's the only one that publishes anything about you. Even
   *  when on, the Rust reporter posts nothing until consent + a username + an API key are stored
   *  (see builder_index.rs). Config-backed, NOT persisted. */
  builderIndexEnabled: boolean;
  /** `[tools].straude` — the SECOND reporting destination, independent of the Builder Index. */
  straudeEnabled: boolean;
  /** Whether the Builder Index consent + settings modal is mounted. UI-only, never persisted:
   *  the modal is where consent is given, so it must never be restored as "already open". */
  builderIndexModalOpen: boolean;
  straudeModalOpen: boolean;
  /** Which Claude Code plugins are pre-enabled in every agent worktree's
   *  .claude/settings.local.json. Mirrors the `[plugins]` TOML table. Config-backed, NOT persisted.
   *
   *  KEYED, not one boolean field per plugin: the field-per-plugin shape meant adding a plugin
   *  required editing this interface, the defaults, the hydrate, and a key→field map in lockstep,
   *  which is exactly why the catalog could not grow. Rust's `PluginsConfig` is keyed for the same
   *  reason. */
  pluginsEnabled: Record<PluginKey, boolean>;
  /** 1Password `.env*` backup. Mirrors [tools].onepassword. Config-backed, NOT persisted.
   *  Unlike every other tool this defaults OFF — see the hydration note below. */
  onepasswordEnabled: boolean;
  /** The 1Password vault backups are written to. Null until the user picks one in Settings;
   *  the backup UI stays in its "pick a vault" state rather than guessing, because writing
   *  secrets into the wrong vault (say, one shared with a team) is not a safe default.
   *  Mirrors [onepassword].vault_id. Config-backed, NOT persisted. */
  onepasswordVaultId: string | null;
  /** Which 1Password account `op` acts as, as its `user_uuid`. Null until the user picks one —
   *  which they only have to do when they're signed in to more than one account, where `op`
   *  otherwise refuses every call with "multiple accounts found". Mirrors
   *  [onepassword].account_id. Config-backed, NOT persisted. */
  onepasswordAccountId: string | null;
  /** Restore backed-up env files into each newly created agent worktree. This is the payoff of
   *  the feature — `.env*` is gitignored, so a worktree never carries one and every worker agent
   *  otherwise starts without its project's secrets. Mirrors [onepassword].seed_worktrees. */
  onepasswordSeedWorktrees: boolean;
  /** Whether the one-time roborev consent modal has already been shown. Set true the first time it
   *  appears (whichever choice the user made) so it never appears again. Mirrors
   *  [roborev].consent_prompted. Config-backed, NOT persisted. */
  roborevConsentPrompted: boolean;
  /** UI-only flag: is the roborev consent modal currently mounted/open? Not config-backed and not
   *  persisted — a transient session flag flipped on at the first reviewable commit (runtimeStore)
   *  and off when the modal resolves (RoborevConsentModal). */
  roborevConsentOpen: boolean;
  /** Why roborev can't actually review, from the last auth self-test — shown under the Roborev row.
   *  UI-only (never persisted): it's re-probed each time the toggle is turned on. null = no problem
   *  observed. This is what keeps a daemon that can't authenticate from *looking* like it's working. */
  roborevAuthWarning: string | null;
  /** What the plugin installer is doing right now, per plugin row — `"installing"` while the fetch
   *  is outstanding, a sentence when it failed, absent when there's nothing to say. UI-only (never
   *  persisted); set by configActions when a toggle is switched on. Same job as
   *  `roborevAuthWarning`: without it, an install that never landed leaves a switch reading ON with
   *  the plugin absent, which is exactly the invisible failure this whole feature keeps hitting. */
  pluginInstallState: Partial<Record<PluginKey, "installing" | string>>;
  /** Non-fatal warnings from the last config load (malformed layer, ignored per-project keys). */
  configWarnings: string[];

  setChiefPat: (pat: string) => void;
  setRuntimeChiefPat: (pat: string) => void;
  /** Set the OS-keychain-sourced PAT in memory (services/chief seeds this at launch and on save). */
  setKeychainChiefPat: (pat: string) => void;
  setChiefProject: (sparkleProjectId: string, chiefProjectId: string) => void;
  setChiefProjectDocState: (chiefProjectId: string, map: Record<string, ChiefDocState>) => void;
  clearChiefDocState: (chiefProjectId: string) => void;
  /** Point a Sparkle project at a DIFFERENT Chief project, dropping the outgoing ledger. */
  relinkChiefProject: (
    sparkleProjectId: string,
    chiefProjectId: string,
    liveProjectIds: Iterable<string>,
  ) => void;
  /** Forget the link entirely, so the next sync resolves one by name (or creates it). */
  unlinkChiefProject: (sparkleProjectId: string, liveProjectIds: Iterable<string>) => void;
  /**
   * Atomically RESERVE `chiefProjectId` for `sparkleProjectId`, or refuse. Returns whether it now
   * holds the link. The check and the write happen in one `set`, which is what a plain read-then-
   * check cannot do — see the doc on the implementation.
   */
  claimChiefLibrary: (
    sparkleProjectId: string,
    chiefProjectId: string,
    liveProjectIds: Iterable<string>,
  ) => boolean;
  setMaxConcurrentWorkers: (n: number) => void;
  setCloudDictation: (on: boolean) => void;
  /** Toggle auto-apply of desktop updates (the "Automatically apply updates" checkbox). */
  setAutoApplyUpdates: (on: boolean) => void;
  /** Toggle deleting a shipped agent's merged branch on close (optimistic; configActions persists). */
  setDeleteMergedBranch: (on: boolean) => void;
  /** Pick the span rectangle used by Appearance → Window. */
  setWindowSpanMode: (mode: SpanMode) => void;
  /** Toggle re-spanning when displays are connected/disconnected. */
  setWindowAutoRespan: (on: boolean) => void;
  /** Record whether the window is currently spanned (gates auto-respan). */
  setWindowIsSpanned: (on: boolean) => void;
  /** Toggle notifications for one agent status. */
  setNotifyStatus: (status: AgentTabStatus, on: boolean) => void;
  /** Toggle one AI feature; the master segment re-derives automatically (aiFeatureMode). */
  setAiFeature: (key: AiFeatureKey, on: boolean) => void;
  /** Optimistically set/clear a GLOBAL approval rule (configActions persists to [approvals]).
   *  `rule` null removes the category from the global mirror. */
  setGlobalApproval: (category: ApprovalCategory, rule: ApprovalRule | null) => void;
  /** Optimistically set (or clear, with null) one concierge tool's autonomy rule. Clearing returns
   *  that tool to its derived default rather than to some other value — which is why this deletes
   *  the key instead of writing a "default" sentinel. configActions persists to
   *  [concierge.tools].<tool>. */
  setConciergeToolPolicy: (tool: string, decision: PolicyDecision | null) => void;
  /** Optimistically set MANY tools' rules in one commit — the settings pane's "Allow everything".
   *
   *  MERGES rather than replaces, and that is the load-bearing half: the map can hold keys naming
   *  no tool (the file is hand-editable), and a bulk apply over the tool catalog has no business
   *  discarding one of those silently. Null clears a key, exactly as the single-tool setter does. */
  setConciergeToolPolicies: (patch: Readonly<Record<string, PolicyDecision | null>>) => void;
  /** REPLACE the whole rule map, rather than merging into it.
   *
   *  Two callers, both needing the wholesale form. `{}` is the pane's "Reset all to defaults" —
   *  distinct from a `setConciergeToolPolicies` of nulls because it also drops keys the catalog does
   *  not name, matching the unset of the whole [concierge.tools] table. And configActions restores a
   *  pre-bulk snapshot through here when a bulk write fails, which a merge cannot express: undoing a
   *  bulk means the keys it ADDED have to go, not just change value. */
  replaceConciergeToolPolicies: (next: ToolPolicyOverrides) => void;
  /** Mark the concierge policy as SETTLED without a successful config read.
   *
   *  Called only from the launch path's `getConfig` failure branch. The policy layer holds back
   *  every non-read-only tool until the human's rules have been read, and with no retry or timeout
   *  a failed read would make that hold permanent for the session (roborev 54260). A read that
   *  failed IS an answer to "what rules did they set" — none we can see — so the derived defaults
   *  are the whole policy, and those are `ask` for everything risky. */
  markConciergeToolPolicySettled: () => void;
  /** Optimistically set the GLOBAL session-resume rule (configActions persists to
   *  [approvals].resume). Mirrors setGlobalApproval but for the resume sibling. */
  setGlobalResume: (rule: ResumeRule) => void;
  /** Bulk-set every AI feature (the All / Off segments). */
  setAllAiFeatures: (on: boolean) => void;
  /** Optimistically toggle one [tools] flag; configActions persists it to config.toml. */
  setToolEnabled: (key: ToolKey, on: boolean) => void;
  /** Optimistically toggle one [plugins] flag; configActions persists it to config.toml. */
  setPluginEnabled: (key: PluginKey, on: boolean) => void;
  /** Set (or clear, with null) what the installer is doing for one plugin row. */
  setPluginInstallState: (key: PluginKey, state: "installing" | string | null) => void;
  /** Optimistically set the chosen 1Password vault (configActions persists
   *  [onepassword].vault_id). Null clears it, returning the UI to its "pick a vault" state. */
  setOnePasswordVaultId: (vaultId: string | null) => void;
  /** Optimistically set the chosen 1Password account (configActions persists
   *  [onepassword].account_id). Null clears it, letting `op` decide again. */
  setOnePasswordAccountId: (accountId: string | null) => void;
  /** Optimistically set worktree seeding (configActions persists
   *  [onepassword].seed_worktrees). */
  setOnePasswordSeedWorktrees: (on: boolean) => void;
  /** Mark the one-time roborev consent modal as shown (configActions persists
   *  [roborev].consent_prompted). */
  setRoborevConsentPrompted: (prompted: boolean) => void;
  /** Open/close the roborev consent modal (UI-only; controls whether the modal is mounted). */
  setRoborevConsentOpen: (open: boolean) => void;
  /** Open/close the Builder Index consent + settings modal (UI-only). */
  setBuilderIndexModalOpen: (open: boolean) => void;
  setStraudeModalOpen: (open: boolean) => void;
  /** Set (or clear, with null) the roborev auth self-test warning shown under the Roborev row. */
  setRoborevAuthWarning: (warning: string | null) => void;
  /** Set the Sparkle self-improvement consent mode (the banner's Always/Case by case/Never control). */
  setSparkleImprovementConsent: (mode: SparkleImprovementConsent) => void;
  /** Record when an hourly improvement pass was last attempted (see improvementLastRunAt). */
  setImprovementLastRunAt: (at: number) => void;
  /** Set the launch-warm opt-in (the "Start automatically when Sparkle opens" control). */
  setImprovementLaunchWarm: (on: boolean) => void;
  /** Record the app version whose What's New the user has now been shown. A blank version is
   *  ignored rather than stored — `useAppInfo` reports "" until Rust answers, and recording that
   *  would look like "nothing seen yet" forever. */
  setLastSeenChangelogVersion: (version: string) => void;
  /** Reflect the effective config (from config.toml) into the mirrored store fields. Called at
   *  startup and whenever the file changes. The file is the source of truth — this is the read side. */
  hydrateFromConfig: (eff: EffectiveConfig) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      chiefPat: "",
      runtimeChiefPat: "",
      keychainChiefPat: "",
      chiefProjectByProject: {},
      chiefDocStateByProject: {},
      maxConcurrentWorkers: 20,
      // Starts permissive and is narrowed by the first hydrate; the enforced cap is always the
      // MIN of this and maxConcurrentWorkers (see enforcedWorkerCap), so a pre-hydrate spawn is
      // still bounded by the user's configured value rather than running unlimited.
      effectiveMaxConcurrentWorkers: 20,
      machineMaxConcurrentWorkers: 20,
      // Before the first hydrate we genuinely do not know what bound the number — and "unknown" is
      // the honest value. Defaulting to "ram" is exactly the assumption that made every at-capacity
      // message blame memory (see concurrencyBasis).
      concurrencyBound: "unknown",
      concurrencyBasis: "",
      cloudDictation: true,
      aiAutoRename: true,
      aiComposer: true,
      aiSuggestedActions: true,
      aiAutoApprove: true,
      aiConcierge: true,
      approvals: {},
      // No explicit rules until the user sets one. Every tool is still governed — by its derived
      // default — so this is a complete starting policy, not an unguarded one.
      conciergeToolPolicy: {},
      conciergeToolPolicyHydrated: false,
      // No orgs are ours until config says so. That makes every repo foreign, i.e. the strict
      // reading — the fail-closed direction to boot in.
      conciergeOwnOrgs: [],
      conciergeProjectPolicy: {},
      resumeRule: DEFAULT_RESUME_RULE,
      conciergeAnswers: DEFAULT_CONCIERGE_ANSWERS,
      autoApplyUpdates: true,
      windowSpanMode: "safe",
      windowAutoRespan: true,
      windowIsSpanned: false,
      notifyStatuses: { ...DEFAULT_NOTIFY_STATUSES },
      sparkleImprovementConsent: DEFAULT_SPARKLE_CONSENT,
      improvementLastRunAt: null,
      improvementLaunchWarm: null,
      lastSeenChangelogVersion: null,

      // Config-file mirror defaults (match SparkleConfig::default() in config.rs; overwritten by hydrate).
      requirePr: true,
      worktreeIsolation: true,
      defaultBranch: "",
      bornFreshFromBase: true,
      deleteMergedBranch: true,
      driftBehindNudge: 10,
      driftAheadNudge: 15,
      driftChangedLines: 1000,
      analyticsEnabled: true,
      previewEagerness: DEFAULT_PREVIEW_EAGERNESS,
      beadCardsExpanded: DEFAULT_BEAD_CARDS_EXPANDED,
      beadCardsExpandedMax: DEFAULT_BEAD_CARDS_EXPANDED_MAX,
      beadsEnabled: true,
      githubEnabled: true,
      guardrailsEnabled: true,
      roborevEnabled: true,
      // Default OFF — nothing is published until the user opts in AND consents.
      builderIndexEnabled: false,
      straudeEnabled: false,
      pluginsEnabled: { ...PLUGIN_DEFAULTS },
      onepasswordEnabled: false,
      onepasswordVaultId: null,
      onepasswordAccountId: null,
      onepasswordSeedWorktrees: false,
      roborevConsentPrompted: false,
      roborevConsentOpen: false,
      builderIndexModalOpen: false,
      straudeModalOpen: false,
      roborevAuthWarning: null,
      pluginInstallState: {},
      configWarnings: [],

      setChiefPat: (pat) => set({ chiefPat: pat.trim() }),
      setRuntimeChiefPat: (pat) => set({ runtimeChiefPat: pat.trim() }),
      setKeychainChiefPat: (pat) => set({ keychainChiefPat: pat.trim() }),
      setCloudDictation: (on) => set({ cloudDictation: on }),
      setAutoApplyUpdates: (on) => set({ autoApplyUpdates: on }),
      setWindowSpanMode: (mode) => set({ windowSpanMode: mode }),
      setWindowAutoRespan: (on) => set({ windowAutoRespan: on }),
      setWindowIsSpanned: (on) => set({ windowIsSpanned: on }),
      setDeleteMergedBranch: (on) => set({ deleteMergedBranch: on }),
      setNotifyStatus: (status, on) =>
        set((s) => ({ notifyStatuses: { ...s.notifyStatuses, [status]: on } })),
      setAiFeature: (key, on) => set({ [AI_FEATURE_FIELD[key]]: on } as Partial<AiFeatureFlags>),
      setAllAiFeatures: (on) =>
        set({
          aiAutoRename: on,
          cloudDictation: on,
          aiComposer: on,
          aiSuggestedActions: on,
          aiAutoApprove: on,
          aiConcierge: on,
        }),
      setGlobalApproval: (category, rule) =>
        set((s) => {
          const next = { ...s.approvals };
          if (rule) next[category] = rule;
          else delete next[category];
          return { approvals: next };
        }),
      markConciergeToolPolicySettled: () =>
        set((s) =>
          // Never UNDO a real hydrate: a slow config read that lands after a transient failure
          // must win, and this must not clobber rules already loaded.
          s.conciergeToolPolicyHydrated ? {} : { conciergeToolPolicyHydrated: true },
        ),
      setConciergeToolPolicy: (tool, decision) =>
        set((s) => {
          const next = { ...s.conciergeToolPolicy };
          if (decision) next[tool] = decision;
          else delete next[tool];
          return { conciergeToolPolicy: next };
        }),
      setConciergeToolPolicies: (patch) =>
        set((s) => {
          const next = { ...s.conciergeToolPolicy };
          for (const [tool, decision] of Object.entries(patch)) {
            if (decision) next[tool] = decision;
            else delete next[tool];
          }
          return { conciergeToolPolicy: next };
        }),
      replaceConciergeToolPolicies: (next) => set({ conciergeToolPolicy: { ...next } }),
      setGlobalResume: (rule) => set({ resumeRule: asResumeRule(rule) }),
      setToolEnabled: (key, on) => set({ [TOOL_FIELD[key]]: on } as Partial<SettingsState>),
      setPluginEnabled: (key, on) =>
        set((s) => ({ pluginsEnabled: { ...s.pluginsEnabled, [key]: on } })),
      setPluginInstallState: (key, state) =>
        set((s) => {
          const next = { ...s.pluginInstallState };
          if (state === null) delete next[key];
          else next[key] = state;
          return { pluginInstallState: next };
        }),
      // Trim + empty→null so a blank id can never read as a configured vault (Rust normalizes the
      // same way); otherwise every `op` call would fail opaquely instead of showing the picker.
      setOnePasswordVaultId: (vaultId) =>
        set({ onepasswordVaultId: normalizeVaultId(vaultId) }),
      setOnePasswordAccountId: (accountId) =>
        set({ onepasswordAccountId: normalizeAccountId(accountId) }),
      setOnePasswordSeedWorktrees: (on) => set({ onepasswordSeedWorktrees: on }),
      setRoborevConsentPrompted: (prompted) => set({ roborevConsentPrompted: prompted }),
      setRoborevConsentOpen: (open) => set({ roborevConsentOpen: open }),
      setBuilderIndexModalOpen: (open) => set({ builderIndexModalOpen: open }),
      setStraudeModalOpen: (open) => set({ straudeModalOpen: open }),
      setRoborevAuthWarning: (warning) => set({ roborevAuthWarning: warning }),
      setSparkleImprovementConsent: (mode) => set({ sparkleImprovementConsent: mode }),
      setImprovementLastRunAt: (at) => set({ improvementLastRunAt: at }),
      setImprovementLaunchWarm: (on) => set({ improvementLaunchWarm: on }),
      setLastSeenChangelogVersion: (version) =>
        set((s) => {
          const next = version.trim();
          return next ? { lastSeenChangelogVersion: next } : s;
        }),

      setChiefProject: (sparkleProjectId, chiefProjectId) =>
        set((s) => ({
          chiefProjectByProject: {
            ...s.chiefProjectByProject,
            [sparkleProjectId]: chiefProjectId,
          },
        })),

      setChiefProjectDocState: (chiefProjectId, map) =>
        set((s) => ({
          chiefDocStateByProject: { ...s.chiefDocStateByProject, [chiefProjectId]: map },
        })),

      clearChiefDocState: (chiefProjectId) =>
        set((s) => {
          const { [chiefProjectId]: _drop, ...rest } = s.chiefDocStateByProject;
          return { chiefDocStateByProject: rest };
        }),

      // --- Re-pointing a project's Chief link (sparkle-ojgvp) ---------------------------------
      // Until now `setChiefProject` had exactly ONE caller — inside runChiefSync — so a link, once
      // established, could not be changed from anywhere in the app. That is fine while the link is
      // only ever discovered, and wrong the moment a human wants to consolidate two libraries into
      // one or recover from a project they deleted.

      /**
       * Re-point `sparkleProjectId` at a different Chief project.
       *
       * DROPS THE OUTGOING LEDGER, and that is the whole reason this is not just `setChiefProject`.
       * `chiefDocStateByProject` is keyed by CHIEF project id and records "path -> {hash, assetId}"
       * for assets that live in THAT project. Carrying it across a re-link would leave the sync
       * holding asset ids belonging to the old library: it would skip uploads whose hash "matches"
       * an asset the new project does not contain, and issue deletes against ids that are not
       * there. Dropping it makes the next run treat the new project as unseen and reconcile from
       * scratch — safe, because upload dedups on content MD5 server-side, so identical docs already
       * in the destination are not re-ingested.
       *
       * A no-op when the target is already the current link, so a stray click cannot throw away a
       * healthy ledger and force a full re-reconcile.
       */
      relinkChiefProject: (sparkleProjectId, chiefProjectId, liveProjectIds) =>
        set((s) => {
          const previous = s.chiefProjectByProject[sparkleProjectId];
          if (previous === chiefProjectId) return {};
          // REFUSED when another Sparkle project already owns that library, because the sync's
          // current-state model makes sharing one MUTUALLY DESTRUCTIVE, not merely redundant.
          // syncProjectMarkdown treats the ledger as the complete desired state for the ONE
          // worktree it just read: every ledger path absent from that tree is deleted from Chief,
          // and the result is persisted wholesale. Two projects on one library therefore delete
          // each other's documents every round — the "Think agent sees half the picture" failure
          // this pane exists to cure, except now with data loss. See `chiefLibraryOwner`, which
          // the picker uses to mark these options so the refusal is never a surprise.
          if (
            isChiefLibraryClaimed(
              s.chiefProjectByProject,
              chiefProjectId,
              sparkleProjectId,
              liveProjectIds,
            )
          ) {
            return {};
          }
          return {
            chiefProjectByProject: {
              ...s.chiefProjectByProject,
              [sparkleProjectId]: chiefProjectId,
            },
            chiefDocStateByProject: dropLedgerIfUnused(s, sparkleProjectId, previous, liveProjectIds),
          };
        }),

      /**
       * Forget the link entirely.
       *
       * The next sync falls back to `ensureChiefProject`'s name matching, which will REUSE a Chief
       * project of the same name if one exists and otherwise CREATE one. That makes this the
       * deliberate opposite of the `project_gone` behaviour, where the dead id is left in place
       * precisely to stop that recreation from happening behind the user's back — here the user is
       * asking for it.
       */
      unlinkChiefProject: (sparkleProjectId, liveProjectIds) =>
        set((s) => {
          const previous = s.chiefProjectByProject[sparkleProjectId];
          if (!previous) return {};
          const { [sparkleProjectId]: _unlinked, ...links } = s.chiefProjectByProject;
          return {
            chiefProjectByProject: links,
            chiefDocStateByProject: dropLedgerIfUnused(s, sparkleProjectId, previous, liveProjectIds),
          };
        }),

      claimChiefLibrary: (sparkleProjectId, chiefProjectId, liveProjectIds) => {
        // ATOMIC, and that is the entire point. The previous version of this guard read the store
        // at the top of runChiefSync, resolved the library over an `await`, and only then compared
        // — so two projects with NO persisted link (first sync, or both freshly unlinked) each
        // computed an EMPTY claimed set, each name-matched onto the same library, and each passed.
        // That established exactly the mutually-destructive sharing the guard exists to prevent,
        // and it is the likeliest way to reach it: two same-named projects, no user action, two
        // debounced syncs in one tick. Deciding and writing inside a single `set` closes the
        // window, because nothing else can interleave between them.
        let held = false;
        set((s) => {
          // ANOTHER project's claim is tested FIRST, ahead of the "we already hold it" shortcut,
          // and the order is load-bearing. Persisted state can hold the sharing OUTRIGHT — two
          // live projects whose links both name this library, from before this guard existed, or
          // because a `project_gone` link neither project dropped got re-pointed onto it. If
          // "already ours" answered first, BOTH projects would pass their claim and each sweep
          // would delete the other's documents: exactly the mutual destruction this refuses.
          // Refusing both parks them at `library_claimed` until a human re-points one, which is
          // the only non-lossy answer available.
          if (
            isChiefLibraryClaimed(
              s.chiefProjectByProject,
              chiefProjectId,
              sparkleProjectId,
              liveProjectIds,
            )
          ) {
            held = false;
            return {};
          }
          held = true;
          if (s.chiefProjectByProject[sparkleProjectId] === chiefProjectId) return {}; // already ours
          return {
            chiefProjectByProject: {
              ...s.chiefProjectByProject,
              [sparkleProjectId]: chiefProjectId,
            },
          };
        });
        return held;
      },

      setMaxConcurrentWorkers: (n) => set({ maxConcurrentWorkers: Math.max(1, Math.floor(n)) }),

      hydrateFromConfig: (eff) => {
        const { config, warnings } = eff;
        // `workers.max_concurrent` is null/absent when the user has NOT pinned a ceiling — the
        // default. The machine-derived limit is then the only bound, and it arrives already
        // computed in `effective_max_concurrent`. Reading the raw field unguarded would be a
        // silent catastrophe here: `Math.floor(null)` is 0, so `Math.max(1, 0)` would pin EVERY
        // auto-configured install to a single worker.
        const pinnedCeiling =
          typeof config.workers.max_concurrent === "number"
            ? Math.max(1, Math.floor(config.workers.max_concurrent))
            : null;
        // `?? pinnedCeiling` covers a backend predating memory-aware concurrency; with neither we
        // have no basis at all, so fall back to 1 rather than inventing a number.
        const derived = Math.max(1, Math.floor(eff.effective_max_concurrent ?? pinnedCeiling ?? 1));
        // `improvement.consent` mirrors sparkleImprovementConsent from config.toml. It is ALSO
        // persisted to localStorage (see partialize), so — unlike the other config-only mirrors —
        // an unset/absent value must NOT overwrite the store: on first launch after upgrade the file
        // has no [improvement] section (Rust sends consent: null) and clobbering here would revert a
        // user's persisted "always" to the default. Only a recognized written value is adopted;
        // null / an older backend / a garbage hand-edit all keep the persisted choice (fail-safe).
        const mirroredConsent = config.improvement?.consent;
        set((s) => ({
          // Concurrency + AI flags (also surfaced in the ⋯ menu controls). With no pinned ceiling
          // the user's "request" IS the derived value, so the two agree and enforcedWorkerCap's
          // min() is a no-op rather than a clamp to a stale default.
          maxConcurrentWorkers: pinnedCeiling ?? derived,
          // The extra Math.min re-asserts the ceiling here so a bad/large backend value can never
          // RAISE the cap above what the user pinned — this store field is what the spawn gate reads.
          effectiveMaxConcurrentWorkers:
            pinnedCeiling === null ? derived : Math.max(1, Math.min(pinnedCeiling, derived)),
          // What the machine alone could carry. `?? derived` covers a backend predating the field;
          // the floor keeps it from ever reading BELOW the enforced number, which would make the UI
          // claim the hardware is the constraint when a pin is.
          machineMaxConcurrentWorkers: Math.max(
            1,
            Math.floor(eff.machine_max_concurrent ?? derived),
          ),
          // The provenance, taken VERBATIM from the backend that computed the number. Neither field
          // is re-derived here: every re-derivation of "why is the cap this?" from the value alone
          // has been wrong, which is the bug this plumbing closes.
          concurrencyBound: eff.concurrency_bound ?? "unknown",
          concurrencyBasis: eff.concurrency_basis ?? "",
          aiAutoRename: config.ai.auto_rename,
          cloudDictation: config.ai.voice_dictation,
          aiComposer: config.ai.composer,
          aiSuggestedActions: config.ai.suggested_actions,
          // Auto-approve master toggle (`?? true` covers an older backend predating [ai].auto_approve).
          aiAutoApprove: config.ai.auto_approve ?? true,
          // `?? true` covers a backend predating [ai].concierge, same as auto_approve above.
          aiConcierge: config.ai.concierge ?? true,
          // GLOBAL approval rules mirror. App.tsx hydrates from the global layer (no project root),
          // so this stays the all-projects view; per-project overrides come from approvalsStore.
          approvals: toApprovalMap(config.approvals),
          // The concierge's per-tool rules, kept verbatim. An absent [concierge] section (an older
          // backend, or simply a user who has set no rules) is the empty map — which is a COMPLETE
          // policy, because every tool falls back to its derived default.
          conciergeToolPolicy: toConciergeToolPolicy(config.concierge?.tools),
          // The per-project half of the same read, under the same flag: one config read settles
          // all three, so there is no window where the global rules are loaded and the project
          // ones are not — which would resolve every project to the looser global answer.
          conciergeOwnOrgs: toConciergeOwnOrgs(config.concierge?.own_orgs),
          conciergeProjectPolicy: toConciergeProjectPolicy(config.concierge?.projects),
          conciergeToolPolicyHydrated: true,
          // GLOBAL session-resume rule (sibling of approvals; own value domain). Coerced so an
          // absent/unknown value degrades to "ask".
          resumeRule: asResumeRule(config.approvals?.resume),
          // GLOBAL concierge-routing flag (the other sibling of approvals; a plain boolean). Coerced
          // so an absent value — an older backend predating the key — degrades to the ON default
          // rather than silently disabling routing.
          conciergeAnswers: asConciergeAnswers(config.approvals?.concierge_answers),
          // Workflow rules (display / advanced).
          requirePr: config.workflow.require_pr,
          worktreeIsolation: config.workflow.worktree_isolation,
          defaultBranch: config.workflow.default_branch,
          bornFreshFromBase: config.workflow.born_fresh_from_base,
          deleteMergedBranch: config.workflow.delete_merged_branch,
          driftBehindNudge: config.workflow.drift.behind_nudge,
          driftAheadNudge: config.workflow.drift.ahead_nudge,
          driftChangedLines: config.workflow.drift.changed_lines,
          // Tools flags. `?? true` treats an absent [tools] block (older backend) as the on-by-default
          // state, matching SparkleConfig::default() — a new install ships every tool on.
          analyticsEnabled: config.tools?.analytics ?? true,
          // Same rule for the same reason: an absent [preview] section reads as the SHIPPED
          // default, never as "never" — a backend predating the key must not read as a user who
          // turned previews off.
          previewEagerness: asPreviewEagerness(config.preview?.agent_eagerness),
          // `[ui]`. An absent section — a backend predating it — reads as the SHIPPED DEFAULTS,
          // never as off: `config.ts` states that rule for the whole section, and reading it as
          // "collapsed" would make a version skew look like the feature had been reverted.
          //
          // The cap is floored at 0 and rounded DOWN. A hand-edited TOML is untrusted input and
          // Rust forwards what it parsed; a negative or fractional value reaching the comparison
          // in `BeadPill` unguarded would silently expand nothing (`i < -1` is false for every i),
          // which is indistinguishable from the feature being switched off.
          beadCardsExpanded: config.ui?.bead_cards_expanded ?? DEFAULT_BEAD_CARDS_EXPANDED,
          beadCardsExpandedMax: normalizeBeadCardsExpandedMax(config.ui?.bead_cards_expanded_max),
          beadsEnabled: config.tools?.beads ?? true,
          githubEnabled: config.tools?.github ?? true,
          guardrailsEnabled: config.tools?.guardrails ?? true,
          roborevEnabled: config.tools?.roborev ?? true,
          // `?? false` here, unlike its on-by-default siblings: an absent [tools] block (older
          // backend) must read as "not opted in", never as "publishing".
          builderIndexEnabled: config.tools?.builder_index ?? false,
          // `?? false` like its Builder Index sibling, and unlike the on-by-default tools: an
          // absent key must never read as consent to publish.
          straudeEnabled: config.tools?.straude ?? false,
          // Plugin flags. Same `?? true` back-compat rule as [tools]: an absent [plugins] block
          // (older backend) means the on-by-default state, matching SparkleConfig::default().
          // An absent [plugins] block (older backend) reads as the on-by-default state, matching
          // SparkleConfig::default(). Each key maps to its snake_case TOML name.
          pluginsEnabled: {
            superpowers: config.plugins?.superpowers ?? PLUGIN_DEFAULTS.superpowers,
            frontendDesign: config.plugins?.frontend_design ?? PLUGIN_DEFAULTS.frontendDesign,
            sparkleGuardrails:
              config.plugins?.sparkle_guardrails ?? PLUGIN_DEFAULTS.sparkleGuardrails,
            sparkleFreshness: config.plugins?.sparkle_freshness ?? PLUGIN_DEFAULTS.sparkleFreshness,
            sparkleMutationCheck:
              config.plugins?.sparkle_mutation_check ?? PLUGIN_DEFAULTS.sparkleMutationCheck,
            sparkleConflictWatch:
              config.plugins?.sparkle_conflict_watch ?? PLUGIN_DEFAULTS.sparkleConflictWatch,
            sparkleSecrets: config.plugins?.sparkle_secrets ?? PLUGIN_DEFAULTS.sparkleSecrets,
            sparkleReviewProbes:
              config.plugins?.sparkle_review_probes ?? PLUGIN_DEFAULTS.sparkleReviewProbes,
            sparklePusher: config.plugins?.sparkle_pusher ?? PLUGIN_DEFAULTS.sparklePusher,
          },
          // NOTE THE ASYMMETRY: every tool above falls back to `?? true`, this one to `?? false`.
          // 1Password backup needs an external account, the `op` CLI, and a chosen vault before it
          // can do anything, so an absent [tools] block must read as OFF — defaulting it on would
          // advertise a capability a fresh install cannot perform. Matches Rust's
          // SparkleConfig::default(). Same reasoning for the two [onepassword] fields: no vault
          // until the user picks one, no worktree seeding until they ask for it.
          onepasswordEnabled: config.tools?.onepassword ?? false,
          // Same rule as every other write path — see normalizeVaultId. Hydration was the one that
          // used to skip it, so a ""/"   " payload landed verbatim and read as "a vault is
          // configured" everywhere downstream.
          onepasswordVaultId: normalizeVaultId(config.onepassword?.vault_id),
          onepasswordAccountId: normalizeAccountId(config.onepassword?.account_id),
          onepasswordSeedWorktrees: config.onepassword?.seed_worktrees ?? false,
          // `?? false`: an absent [roborev] block (older backend) means we've never prompted, so a
          // first reviewable commit still surfaces the one-time consent modal.
          roborevConsentPrompted: config.roborev?.consent_prompted ?? false,
          // Adopt the mirrored consent ONLY when it's one of the three known modes; otherwise keep
          // the store's persisted value (see mirroredConsent above for why this can't clobber).
          sparkleImprovementConsent:
            mirroredConsent === "always" ||
            mirroredConsent === "case_by_case" ||
            mirroredConsent === "never"
              ? mirroredConsent
              : s.sparkleImprovementConsent,
          configWarnings: warnings,
        }));
      },
    }),
    {
      name: "sparkle-settings",
      storage: createJSONStorage(() => localStorage),
      // v0 → v1: preserve a prior `aiEnabled=false` opt-out across the binary→four-flag schema
      // change so we never silently re-arm AI/credits on upgrade. v1 → v2: seed autoApplyUpdates
      // (default on) for existing installs. v2 → v3: add lastSeenChangelogVersion as an explicit
      // null so the in-app What's New treats an existing install as a first run. See migrateSettings.
      version: 3,
      migrate: migrateSettings,
      // Merge persisted state over the live defaults, but DEEP-merge notifyStatuses so a store
      // saved before this field existed (or one missing a newly-added status) inherits the
      // per-status defaults instead of dropping to undefined. Everything else is a shallow
      // override, matching zustand's default merge.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...p,
          notifyStatuses: { ...DEFAULT_NOTIFY_STATUSES, ...(p.notifyStatuses ?? {}) },
        };
      },
      // Persist everything EXCEPT runtimeChiefPat — it's re-resolved from env at each launch, so
      // persisting it would let a removed/rotated env token linger stale until startup runs.
      // NOTE on the config-mirrored fields: config.toml is the source of truth (hydrateFromConfig
      // overwrites these at startup + on every change). The NEW workflow-mirror fields (requirePr,
      // drift*, etc.) are intentionally NOT persisted here — re-read from the file each launch. But
      // maxConcurrentWorkers + the four AI flags STAY persisted as a migration-safe fallback: on a
      // first upgrade config.toml does not exist yet, and these localStorage values are the only
      // record of a user's prior AI opt-out (the v0→v1 migration that guards against silently
      // re-arming billable AI/credits). They stay in lockstep with the file because every UI write
      // goes through both (configActions: optimistic store update → file write → hydrate).
      partialize: (s) => ({
        // chiefPat stays persisted as the READ-ONLY legacy fallback (keychain is preferred; the
        // full localStorage scrub is deferred to a follow-up bead).
        chiefPat: s.chiefPat,
        chiefProjectByProject: s.chiefProjectByProject,
        chiefDocStateByProject: s.chiefDocStateByProject,
        maxConcurrentWorkers: s.maxConcurrentWorkers,
        cloudDictation: s.cloudDictation,
        aiAutoRename: s.aiAutoRename,
        aiComposer: s.aiComposer,
        aiSuggestedActions: s.aiSuggestedActions,
        aiAutoApprove: s.aiAutoApprove,
        aiConcierge: s.aiConcierge,
        autoApplyUpdates: s.autoApplyUpdates,
        windowSpanMode: s.windowSpanMode,
        windowAutoRespan: s.windowAutoRespan,
        notifyStatuses: s.notifyStatuses,
        sparkleImprovementConsent: s.sparkleImprovementConsent,
        improvementLastRunAt: s.improvementLastRunAt,
        improvementLaunchWarm: s.improvementLaunchWarm,
        lastSeenChangelogVersion: s.lastSeenChangelogVersion,
      }),
    },
  ),
);
