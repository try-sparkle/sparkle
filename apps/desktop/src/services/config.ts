// Frontend wrapper over the Rust editable-config commands (config.rs). The TOML config file is
// the single source of truth; this module is the only place the UI talks to it. See the design
// spec: docs/superpowers/specs/2026-06-29-editable-config-file-design.md
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// RE-EXPORTED, not re-declared. `packages/core/pusherPolicy.ts` already owns the `[pushers]` wire
// shape because it owns the thing that resolves it (`resolvePusherPolicy`), and a second copy here
// would be a type that can silently disagree with the only code that reads it. Its fields are typed
// `unknown` on purpose — this is what a HAND-EDITED TOML table can hold, and Rust forwards a
// wrong-typed value's absence rather than a corrected one.
import type { PushersConfigPayload } from "@sparkle/core";
export type { PushersConfigPayload };

export interface DriftConfig {
  behind_nudge: number;
  ahead_nudge: number;
  changed_lines: number;
}
export interface WorkflowConfig {
  require_pr: boolean;
  worktree_isolation: boolean;
  default_branch: string;
  born_fresh_from_base: boolean;
  delete_merged_branch: boolean;
  drift: DriftConfig;
}
export interface WorkersConfig {
  /** The user's PINNED ceiling, or null/absent for AUTO — the default, where the limit is derived
   *  from the machine (RAM and CPU cores). Either way the number actually enforced is
   *  `EffectiveConfig.effective_max_concurrent`.
   *
   *  Nullable deliberately, so the compiler forces every reader to handle auto. An unguarded
   *  `Math.floor(max_concurrent)` on the auto case yields 0, which clamps to a single worker —
   *  a silent, total throttle rather than a visible error. */
  max_concurrent: number | null;
  /** Per-agent V8 heap cap in MiB (NODE_OPTIONS=--max-old-space-size). 0 = opt out.
   *  Optional so callers guard: a Rust backend predating this key omits it. */
  agent_heap_mb?: number;
}
export interface AiConfig {
  auto_rename: boolean;
  voice_dictation: boolean;
  composer: boolean;
  suggested_actions: boolean;
  /** Master switch for Sparkle Auto-Approve (nudging + auto-answering). Default true. */
  auto_approve: boolean;
  /** The concierge column's brain + tool surface. Optional so callers guard: a Rust backend
   *  predating it omits the field (hydrate reads `?? true`). */
  concierge?: boolean;
}
/** Per-category Sparkle Auto-Approve rules. Each is `"always"` / `"never"` / null (absent = ask +
 *  nudge). Serde serializes an absent rule as null. Mirrors ApprovalsConfig in config.rs. */
export interface ApprovalsConfig {
  skill: string | null;
  bash: string | null;
  edit: string | null;
  mcp: string | null;
  fetch: string | null;
  other: string | null;
  /** Session-resume rule. NOT an "always"/"never" category — one of "ask" | "summary" | "full"
   *  (default "ask"). Governs how the Claude Code session-resume prompt is auto-answered while
   *  [ai].auto_approve is on. Optional so callers guard: a Rust backend predating it omits it. */
  resume?: string | null;
  /** Plan-exit rule. NOT an "always"/"never" category — one of "ask" | "auto" | "manual"
   *  (default "auto"). Governs how Claude Code's "ready to execute … proceed?" prompt is
   *  auto-answered while [ai].auto_approve is on. */
  plan?: string | null;
  /** May a prompt the local classifier declines to answer be handed to the concierge, which reads
   *  it and answers? Default true. A SEPARATE switch from [ai].auto_approve, which is about a local
   *  regex pressing buttons unread — see approvalCategories.ts.
   *
   *  `boolean`, not `boolean | null`, and that is not an oversight: the Rust side stores this as a
   *  bare `bool` rather than an `Option<bool>` precisely so it can never cross the wire as `null`
   *  (serde emits `None` as an explicit null). It stays OPTIONAL only for the usual back-compat
   *  reason — a Rust backend predating the key omits it outright. */
  concierge_answers?: boolean;
}
/** The concierge's PER-TOOL autonomy policy, mirroring ConciergeConfig in config.rs.
 *
 *  `tools` is a free-form map of tool name → `"allow"` | `"ask"` | `"deny"`. Typed as
 *  `Record<string, string>` rather than a union on both sides ON PURPOSE: this is a hand-edited
 *  file, so both the keys and the values are untrusted. The narrowing lives in
 *  services/conciergeTools/policy.ts, which is also where an absent key resolves to a default
 *  derived from the tool's risk class — so a small file is not a small policy. */
export interface ConciergeConfig {
  tools: Record<string, string>;
  /** The reply linter's policy (`[concierge.checks]`). Optional for the same back-compat reason as
   *  every other block here: a Rust backend predating it omits the key. An absent section is NOT
   *  "lint with defaults" — services/conciergeLintPolicy.ts resolves it to the disabled policy, so
   *  an older backend can never have a gate switched on underneath it. */
  checks?: ConciergeChecksConfigPayload;
  /** The orgs whose repos count as OURS (`[concierge].own_orgs`). Everything else is FOREIGN, which
   *  floors anything touching its main branch at `ask` — see conciergeTools/policy.ts's lattice.
   *
   *  `?: T | null`, not `?: T`, and the difference is not style. A Rust `Option` crosses the wire as
   *  an explicit `null`; it is omitted only when the field carries `skip_serializing_if`. So `?: T`
   *  alone describes a shape the wire cannot produce, and a parser written against it rejects the
   *  payload — all-or-nothing, silently, leaving the feature permanently inert. AGENTS.md has the
   *  measured case. Absent (an older backend) and null (no orgs configured) mean the same thing
   *  here: no org is ours, which is the fail-closed reading. */
  own_orgs?: string[] | null;
  /** Per-project rules, keyed by LOWERCASED `owner/repo`
   *  (`[concierge.projects."owner/repo".tools]`). A project entry can only ever TIGHTEN the global
   *  tier above it, so a hand-edited (or hostile) value has no permissive direction to fail in.
   *
   *  Stored GLOBALLY, never in the repo's own `.sparkle/config.toml` — `apply_project`'s section
   *  allowlist in config.rs keeps ignoring `[concierge]` from a project file, which matters most
   *  for exactly the repos this feature is about: a repo we do not own must not get a vote on what
   *  Sparkle may do inside it. Same `| null` reasoning as `own_orgs`, at both levels. */
  projects?: Record<string, { tools?: Record<string, string> | null } | null> | null;
}
/** One `[concierge.checks.<id>]` row EXACTLY as Rust serializes it (`ConciergeCheck` in config.rs,
 *  `rename_all = "snake_case"`).
 *
 *  Every field is typed at its wire width, not at its intended width: `severity` is `string` and not
 *  the `Severity` union because config.toml is HAND-EDITED and Rust keeps an unrecognized value
 *  verbatim on purpose (the raw string is what makes the warning nameable). Narrowing it here would
 *  be a lie the compiler then propagates. The narrowing happens once, in
 *  services/conciergeLintPolicy.ts. */
export interface ConciergeCheckPayload {
  enabled: boolean;
  severity: string;
  autofix: boolean;
  threshold?: number | null;
  words?: string | null;
}
/** The `[concierge.checks]` table as Rust serializes it. `log_matches` is snake_case on the wire;
 *  the camelCase `logMatches` the linter reads is produced by the mapper, not by this type. */
export interface ConciergeChecksConfigPayload {
  enabled: boolean;
  log: boolean;
  log_matches: boolean;
  checks: Record<string, ConciergeCheckPayload>;
}
/** Opinionated non-AI tools (machine-wide; ignored in a per-project file). Each defaults on for a
 *  new install; false means that tool is used nowhere in Sparkle. Surfaced in the "Tools" pane. */
export interface ToolsConfig {
  analytics: boolean;
  beads: boolean;
  github: boolean;
  guardrails: boolean;
  /** Score a pull request that changes what Sparkle says or does to a person against
   *  HumaneBench's 8 humane-technology principles, and block a below-the-bar merge until a human
   *  overrides it. Defaults ON. Optional so callers guard: a Rust backend predating the key omits
   *  it, and the hydrate resolves an absent value through `?? true` — the same back-compat rule
   *  the `builder_index`/`straude` pair uses, in the opposite direction. */
  humanebench?: boolean;
  roborev: boolean;
  /** Back your `.env*` files up to a 1Password vault. The one tool here that defaults OFF — it
   *  needs a 1Password account, the `op` CLI, and a chosen vault before it can do anything. */
  onepassword: boolean;
  /** Publish daily token totals to the public tokenmaxxing leaderboard. The one flag here that
   *  defaults FALSE. Optional so callers guard: a Rust backend predating it omits the key, and
   *  an absent value must read as "off". */
  builder_index?: boolean;
  /** The second reporting destination (straude.com). Default OFF, independent of
   *  `builder_index` — turning one on says nothing about the other. */
  straude?: boolean;
}
/** Claude Code marketplace plugins Sparkle pre-enables for every agent it spawns. Repo-scoped and
 *  per-project overridable (like [workflow]), so a repo can pick the plugins its codebase wants. */
export /** The `[plugins]` table as Rust serializes it.
 *
 *  Every key OPTIONAL on purpose: the hydrate already resolves each one through `?? <default>`,
 *  and a Sparkle frontend can run against an older backend whose `KNOWN_PLUGINS` predates a key.
 *  Requiring them would make that a type error while the runtime handled it fine. */
interface PluginsConfig {
  superpowers?: boolean;
  frontend_design?: boolean;
  sparkle_guardrails?: boolean;
  sparkle_freshness?: boolean;
  sparkle_mutation_check?: boolean;
  sparkle_conflict_watch?: boolean;
  sparkle_secrets?: boolean;
  sparkle_review_probes?: boolean;
  sparkle_pusher?: boolean;
}
/** roborev machine-wide state (the one-time consent flag), its own section so Rust can gate the
 *  first-run modal on it. Machine-wide (like [tools]); ignored in a per-project file. */
export interface RoborevConfig {
  consent_prompted: boolean;
}
/** Machine-wide mirror of the Sparkle-improvement consent, so headless agents can read it from the
 *  file instead of the webview store. Machine-wide (like [roborev]); ignored in a per-project file.
 *  `consent` is null until the user sets it — see the Rust `ImprovementConfig` on why it stays
 *  distinguishable from a written value (so a hydrate never clobbers a persisted store choice). The
 *  value mirrors `SparkleImprovementConsent` in settingsStore.ts; kept inline to avoid a store↔service
 *  import cycle, and typed `| null` for the unset case. */
export interface ImprovementConfig {
  consent: "always" | "case_by_case" | "never" | null;
  /** Runtime arm for the never-idle watcher. Rust sends it as a plain bool (always present, never
   *  null); optional here only to tolerate a backend predating the key, which the reader treats as
   *  the `true` default (`?? true`). Replaces the old build-time `VITE_SPARKLE_NEVER_IDLE` flag. */
  never_idle_armed?: boolean;
}
/** The backlog drainer's kill-switch (`[drainer]`). Machine-wide (like `[roborev]`/`[babysit]`);
 *  ignored in a per-project file. Ships `enabled: true`. Config-backed and NOT persisted to
 *  localStorage — re-read from the file each launch (see `settingsStore.ts` `drainerEnabled`). */
export interface DrainerConfig {
  enabled: boolean;
}
/** 1Password env-backup state (chosen vault + worktree seeding). Machine-wide; ignored in a
 *  per-project file — and here that's a security boundary, not just tidiness: a project-level
 *  value would let one repo redirect where another repo's secrets are written. */
export interface OnePasswordConfig {
  /** The vault chosen in the one-time picker; null/absent until then. Rust normalizes a blank
   *  string to absent, so a falsy value here always means "no vault picked yet". */
  vault_id?: string | null;
  /** Which 1Password account `op` acts as, as its `user_uuid`; null/absent until chosen. Only
   *  needed when more than one account is signed in — `op` then refuses every call with "multiple
   *  accounts found" unless it is told which. Keyed on the uuid, never the email: one person can be
   *  signed in twice under the same email. */
  account_id?: string | null;
  /** Restore backed-up env files into each newly created agent worktree. */
  seed_worktrees: boolean;
}

/** One configured publish destination. Mirrors Rust's `PublishDestination`.
 *
 *  Never carries a token: the credential lives in the OS keychain and is referenced by the
 *  destination's id, so a serialized config.toml can be pasted into a bug report without leaking
 *  one. `hasCredentialInKeychain` answers the pane's only legitimate question about it. */
export interface PublishDestination {
  name: string;
  url: string;
  has_credential_in_keychain: boolean;
}

/** [publish] — MACHINE-WIDE, like [concierge] and [onepassword]. A per-repo `.sparkle/config.toml`
 *  that sets it is IGNORED with a warning: a destination is a network egress target Sparkle sends a
 *  bearer token to, and a cloned repo must not be able to grant itself one.
 *
 *  Mirrors Rust's `config::PublishConfig`. */
export interface PublishConfig {
  /** The destination id publish ops act on.
   *
   *  `string | null`, NOT `active?: string`. It is a Rust `Option<String>` with no
   *  `skip_serializing_if`, so serde emits THE KEY WITH A `null` VALUE — a `?:` parser would
   *  describe a shape the wire cannot produce (AGENTS.md's Rust-`Option` seam). `null` means no
   *  destination has been chosen, and publish ops then refuse rather than guessing. */
  active: string | null;
  /** Configured destinations, keyed by id. Empty on a fresh install. */
  destinations: Record<string, PublishDestination>;
}
/** Branch/build freshness guardrails (read by the build script + session-start staleness hook). */
export interface FreshnessConfig {
  staleness_warn_commits: number;
  stale_build_block_commits: number;
  require_fresh_branch: boolean;
}
/** Which PR-scoped reviewer watches this repo, or `"none"`. `"none"` retires the merge gate's
 *  CONVERGENCE half — which cannot be satisfied once no reviewer will ever post again — but NOT its
 *  probe half: `[blocking]` probes already on a PR are real findings and still block. `pr_reviewer`
 *  is a plain Rust `String`, so it is always present on the wire (never null). */
export interface ReviewConfig {
  pr_reviewer: string;
}
// NOTE: there is no `VoiceConfig` mirror here any more. It described exactly three keys — the wake
// word, the stop word and pause-on-submit — and all three were retired with the wake word itself.
// What remains in Rust's `[voice]` (the microphone UID and the virtual-input opt-in) has never been
// read through this shape: it goes through its own Tauri commands (services/audioInputs), so adding
// an empty interface back would only invite a second, drifting source for the same settings.
/** Menu-bar capture flow (machine-wide; ignored in a per-project file). */
export interface CaptureConfig {
  popover_shortcut: string;
}
/** Reader-facing display preferences — today, the shape a bead card draws in when the concierge
 *  names a bead. Machine-wide (like [capture]); a per-project value is ignored with a warning, and
 *  here that is not merely tidiness: the concierge column is cross-project by construction, so one
 *  reply can name beads from three repos and there would be no coherent "the project's" answer.
 *
 *  Mirrors `UiConfig` in config.rs. Both fields are plain Rust scalars (`bool`/`u32`), never
 *  `Option`, so neither can cross the wire as `null` — see AGENTS.md, "A Rust `Option` crosses the
 *  wire as `null`". They stay OPTIONAL here only for the usual back-compat reason every sibling
 *  block carries: a Rust backend predating [ui] omits the section outright. */
export interface UiConfig {
  /** Render a bead card EXPANDED the moment the concierge names it, rather than as a pill to
   *  click open. Default true; `false` restores the pre-2026-08 click-to-expand behaviour exactly. */
  bead_cards_expanded?: boolean;
  /** How many cards ONE reply may expand before the rest fall back to pills. `0` = no cap (the
   *  shipped default). Counted over ids that RESOLVE, never over id-shaped prose. */
  bead_cards_expanded_max?: number;
}
/** One criterion in a stage definition. `kind` is "auto" (observed via `signal`) or "manual"
 *  (a human ticks it); `signal` is a known auto-signal id, present iff kind === "auto".
 *  Field casing mirrors the Rust serde output exactly (snake_case, Option → value | null). */
export interface StageCriterion {
  text: string;
  kind: string;
  signal: string | null;
}
/** Per-project "Done" stage definition. Undefined = null description + empty criteria. */
/** The `[advisor]` wire shape. Mirrors `AdvisorConfig` in `config.rs` (serde snake_case).
 *
 *  Both fields OPTIONAL for the back-compat reason `tools?` records: a payload from a Rust backend
 *  predating `[advisor]` omits the whole section. An absent section reads as the SHIPPED DEFAULTS
 *  (`resolveAdvisorConfig` in `services/advisor/config`), not as disabled — treating "the backend is
 *  older than the section" as off would silently stop a pass that build is in fact running, and the
 *  user would have no switch to turn back on. That is safe to do here ONLY because the zero-spend
 *  gate, not this flag, is what bounds spend. */
export interface AdvisorConfigPayload {
  enabled?: boolean;
  model?: string;
}

/** The `[babysit]` wire shape. Mirrors `BabysitConfig` in `config.rs` (serde snake_case). */
export interface BabysitConfigPayload {
  enabled?: boolean;
  cooldown_minutes?: number;
  recovery_cooldown_minutes?: number;
  max_dispatches_per_hour?: number;
}

export interface DoneConfig {
  description: string | null;
  criteria: StageCriterion[];
}
/** Per-project "Delivered" stage definition + the detected production-ship signal. */
export interface DeliveredConfig {
  description: string | null;
  detected_method: string | null;
  confidence: string | null;
  confidence_note: string | null;
  learned: boolean;
  criteria: StageCriterion[];
}
export interface SparkleConfig {
  workflow: WorkflowConfig;
  workers: WorkersConfig;
  ai: AiConfig;
  // Optional so callers guard: an older Rust backend (predating [tools]) omits it. The current
  // backend always sends it; hydrateFromConfig defaults each flag to on when absent.
  tools?: ToolsConfig;
  // Optional for the same back-compat reason as `tools?` above: a payload from a Rust backend
  // predating [plugins] omits it. hydrateFromConfig defaults each flag to on when absent.
  plugins?: PluginsConfig;
  // Optional for the same back-compat reason as `tools?` above: a payload from a Rust backend
  // predating [roborev] omits it. Callers read `config.roborev?.consent_prompted ?? false`.
  roborev?: RoborevConfig;
  /** Optional for the same back-compat reason as `roborev?` above: a payload from a Rust backend
   *  predating [improvement] omits it. Callers read `config.improvement?.consent ?? <store value>`,
   *  so an absent section (or a null consent) keeps the store's persisted choice. */
  improvement?: ImprovementConfig;
  /** The backlog drainer's kill-switch. Optional for the same back-compat reason as `improvement?`
   *  above: a payload from a Rust backend predating [drainer] omits it, so callers read
   *  `config.drainer?.enabled ?? true` — an absent section keeps the ON default, never "off". */
  drainer?: DrainerConfig;
  /** Optional for the same back-compat reason as `tools?`/`roborev?` above: a payload from a Rust
   *  backend predating [onepassword] omits it. Callers must guard and fall back to the off/unset
   *  defaults — never read an absent section as "enabled". */
  onepassword?: OnePasswordConfig;
  /**
   * Where Sparkle may publish a post (`[publish]`, bead `sparkle-131ms.3`). Machine-wide, like
   * `[concierge]`: a destination is a network-egress target Sparkle sends a bearer token to, so a
   * per-project file cannot set one.
   *
   * OPTIONAL for the same back-compat reason as `onepassword?` above — a payload from a Rust
   * backend predating `[publish]` omits it. An absent section means SPARKLE CAN PUBLISH NOWHERE,
   * which is also the shipped default and the only safe reading: never treat it as "publishing is
   * on with whatever destination we can find".
   */
  publish?: PublishConfig;
  freshness: FreshnessConfig;
  /** Optional for the same back-compat reason as `tools?`/`roborev?` above: a payload from a Rust
   *  backend predating [review] omits it. An absent section means "a reviewer is expected", the
   *  fail-closed default — never read it as "no reviewer, gate off". */
  review?: ReviewConfig;
  capture: CaptureConfig;
  /** Reader-facing display preferences (bead-card expansion). Optional for the same back-compat
   *  reason as `tools?`/`roborev?` above: a payload from a Rust backend predating [ui] omits it.
   *  An absent section reads as the SHIPPED DEFAULTS (expanded, uncapped) rather than as off —
   *  `hydrateFromConfig` resolves each key through `?? <default>`. */
  ui?: UiConfig;
  // Optional so callers must guard: an older Rust backend (predating [voice]) omits it at runtime.
  // The current backend always sends it, but the type stays honest about the config-changed payload.
  /** Per-category Sparkle Auto-Approve rules. Optional so callers guard: an older Rust backend
   *  (predating [approvals]) omits it; the current backend always sends it. */
  approvals?: ApprovalsConfig;
  /** The concierge's per-tool autonomy policy. Optional for the same back-compat reason as
   *  `tools?`/`roborev?` above: a payload from a Rust backend predating [concierge] omits it.
   *  An absent section means "no explicit rules", which is a perfectly good state — every tool
   *  then sits on the default derived from its risk class. */
  concierge?: ConciergeConfig;
  /** The Pusher's operating envelope. Optional for the same back-compat reason as
   *  `tools?`/`concierge?` above: a payload from a Rust backend predating [pushers] omits it.
   *  An absent section is NOT "Pushers are on with the shipped defaults" — `resolvePusherPolicy`
   *  reads it as DISABLED, because a backend with no [pushers] concept cannot be running one. */
  pushers?: PushersConfigPayload;
  /**
   * The `/babysit-pr` auto-dispatch envelope, including its kill switch.
   *
   * OPTIONAL for the same reason as `pushers?` above — a payload from a Rust backend predating
   * `[babysit]` omits it. Unlike Pushers, an absent section here reads as the SHIPPED DEFAULTS
   * rather than as disabled: the sweep is compiled into any build that has this field at all, so
   * treating "the backend is older than the section" as off would silently stop a loop that build
   * is in fact running, and the user would have no switch to turn back on.
   */
  babysit?: BabysitConfigPayload;
  /** The second-model advisor pass at the epic handoff. Optional for the same back-compat reason as
   *  `babysit?` above; an absent section reads as the shipped defaults, not as disabled. */
  advisor?: AdvisorConfigPayload;
  /** Per-project "Done" stage definition (Definable Done & Delivered feature). */
  done: DoneConfig;
  /** Per-project "Delivered" stage definition + detected production-ship signal. */
  delivered: DeliveredConfig;
  /** What the Builder Index reporter publishes, once `tools.builder_index` has turned it on.
   *  Optional for the same back-compat reason as `pushers?`/`babysit?` above: a payload from a Rust
   *  backend predating `[builder_index]` omits it. An absent section reads as "nothing excluded",
   *  which is also the shipped default. */
  builder_index?: BuilderIndexConfig;
  /** Live in-app browser preview (bead `sparkle-3475b`). Optional for the same back-compat reason
   *  as `builder_index?`/`pushers?` above: a payload from a Rust backend predating [preview] omits
   *  it. An absent section reads as "no preview support in this build" — callers that need a
   *  default fall back to the shipped ones (`enabled: true`, `idle_grace_min: 10`,
   *  `agent_eagerness: "visual"`) rather than treating an absent section as disabled. */
  preview?: PreviewConfig;
  /** The fleet's global CI-concurrency budget + release priority (`services/ciBudgetGovernor.ts`).
   *  Machine-wide, like `workers`. Optional for the same back-compat reason as `builder_index?`
   *  above: a payload from a Rust backend predating `[fleet]` omits it — in which case the governor
   *  is left DISABLED (the singleton ships at budget 0), i.e. the old-backend fallback is "no
   *  throttle", never a silent throttle the user cannot see. The current backend always sends it. */
  fleet?: FleetConfig;
}
/** The `[fleet]` table as Rust's `FleetConfig` serializes it (`config.rs`), field for field.
 *  Machine-wide: a per-project `[fleet]` is ignored with a warning, because the budget protects one
 *  SHARED runner pool that every project's agents push against. */
export interface FleetConfig {
  /** Max build-agent ships that may have CI-triggering work presumed in flight at once; a new ship
   *  past this QUEUES until a slot frees. `0` disables the governor (every ship pushes immediately —
   *  the opt-out, not "no budget"). */
  ci_budget: number;
  /** How long, in seconds, an occupied slot is held after its ship pushes — the presumed CI-run
   *  window and the governor's safety drain (the app does not poll each run to completion). */
  ci_lease_secs: number;
}
/** The `[builder_index]` table as Rust serializes it. Machine-wide; ignored in a per-project file —
 *  and here that is a boundary, not tidiness: a repo must not be able to change what its owner's
 *  machine publishes about them, in either direction. */
export interface BuilderIndexConfig {
  /** Skill names withheld from the public profile's SKILLS row. Already normalized by Rust
   *  (trimmed, lowercased, empties dropped), matching tkmx-client's `applyExclusions` so the two
   *  reporters agree on what a name means. */
  skills_exclude: string[];
}
/** The `[preview]` table as Rust's `PreviewConfig` serializes it (`config.rs`), field for field —
 *  do not add a field that struct cannot emit. Repo-scoped, per-project overridable. */
export interface PreviewConfig {
  /** Master switch. `false` = never detect, never spawn a preview server. */
  enabled: boolean;
  /** How long a preview keeps serving after its pane is covered, before it is stopped. */
  idle_grace_min: number;
  /** `"visual" | "always" | "never"` — how eagerly an AGENT is told to open a preview of its own
   *  work, in the brief it is given. Kept as `string` rather than a union: Rust validates and falls
   *  back to `"visual"`, so the wire can only ever carry one of the three, and typing it as
   *  `string` matches how this file treats every other enum-ish config value. (There used to be a
   *  sibling `auto_open` governing when a preview PANE revealed itself; the pane was removed on
   *  2026-08-19 in favour of a concierge card, which surfaces itself.) */
  agent_eagerness: string;
}
/** The merged effective config plus any non-fatal load warnings (malformed layer, ignored keys). */
export interface EffectiveConfig {
  config: SparkleConfig;
  warnings: string[];
  /** The concurrency limit to ENFORCE: what the machine can carry, `min(RAM-derived, cores × 2)`.
   *  Under AUTO (`max_concurrent: null`) this is the ONLY bound; with a pinned ceiling it is
   *  additionally capped by it. Optional so callers guard: a Rust backend predating machine-aware
   *  concurrency omits it (fall back to `workers.max_concurrent`, or 1 when that is null too). */
  effective_max_concurrent?: number;
  /** What the MACHINE alone could carry, ignoring any `[workers].max_concurrent` pin. Equal to
   *  `effective_max_concurrent` under AUTO. Optional for the same back-compat reason as above. */
  machine_max_concurrent?: number;
  /** Which dimension binds `effective_max_concurrent`. Surfaced so user-facing copy can NAME it
   *  instead of asserting RAM unconditionally — which is wrong on every core-bound machine, and is
   *  what sent a human chasing memory that was 94% free. Optional: an older backend omits it, in
   *  which case the copy must fall back to saying nothing about the cause rather than guessing. */
  concurrency_bound?: ConcurrencyBound;
  /** One sentence naming that dimension with its arithmetic, e.g. `"CPU-bound: 18 cores × 2 agents
   *  per core"`. Composed in Rust alongside the number it explains so the two cannot disagree. */
  concurrency_basis?: string;
}

/**
 * Which dimension binds the enforced concurrency ceiling. Mirrors Rust's `config::Bound`.
 *
 * The first five are all PREDICTIONS, made once at startup from facts that don't change while the
 * app runs — installed RAM, core count, a pinned number in config.toml. They answer "what could
 * this machine carry, in principle". The last two come from a LIVE reading of the machine (see
 * services/memoryAdmission) and answer a different question — "what can it carry right NOW" — so a
 * refusal carrying one of them names something the user can act on this minute:
 *
 *  - `"available"` — a fact about this MOMENT: the free memory left after everything currently
 *    resident (Chrome, a runaway agent, someone's video export) won't hold another agent. The
 *    remedy is *close something*, not *buy more RAM*; the static ceiling is unchanged and the slot
 *    comes back on its own the moment the machine frees up.
 *  - `"pressure"` — the OS itself says the machine is squeezed: the compressor is working or swap
 *    is in use. This is not arithmetic over a free-page count, it is the kernel's own verdict, and
 *    it means starting another agent would make an already-degraded machine worse.
 *
 * Both are strictly NARROWING — sampling may only ever refuse, never raise the predicted ceiling.
 */
export type ConcurrencyBound =
  | "cpu"
  | "ram"
  | "both"
  | "pinned"
  | "unknown"
  | "available"
  | "pressure";
export interface ConfigPaths {
  global: string;
  /** Present only when a project root is in context. */
  project: string | null;
}

/** Effective config for the active project (global + that project's overrides), or the global
 *  layer when no project root is supplied. The startup mirror passes no root (global-only) by
 *  design — see App.tsx; per-project [workflow] overrides are applied by the Rust engine itself. */
export function getConfig(projectRoot?: string | null): Promise<EffectiveConfig> {
  return invoke("get_config", { projectRoot: projectRoot ?? null });
}

/** Set one dotted key (e.g. "workers.max_concurrent") in the global file, preserving comments. */
export function setConfigValue(path: string, value: boolean | number | string): Promise<void> {
  return invoke("set_config_value", { path, value });
}

/** Set several dotted keys in ONE atomic write (one config-changed event). Use for bulk actions
 *  (e.g. All/Off AI features) to avoid the partial-file flicker of separate writes. */
export function setConfigValues(
  values: Record<string, boolean | number | string>,
): Promise<void> {
  return invoke("set_config_values", { values });
}

/** Remove one dotted key from the GLOBAL file (comment-preserving). No-op if the key is absent. */
export function unsetConfigValue(path: string): Promise<void> {
  return invoke("unset_config_value", { path });
}

/** Set one dotted key in a PROJECT's gitignored `.sparkle/local.toml` (comment-preserving). The
 *  tracked `.sparkle/config.toml` is repo policy and is never written at runtime (sparkle-5ur8s);
 *  the local layer sits directly above it, so the resolved value is the same. */
export function setProjectConfigValue(
  projectRoot: string,
  path: string,
  value: boolean | number | string,
): Promise<void> {
  return invoke("set_project_config_value", { projectRoot, path, value });
}

/** Clear one dotted key for a PROJECT. Removes it from `.sparkle/local.toml` and, when the tracked
 *  `.sparkle/config.toml` still sets it, records a `[cleared]` tombstone there so the RESOLVED value
 *  actually changes — the tracked file is never written. No-op if neither layer sets the key. */
export function unsetProjectConfigValue(projectRoot: string, path: string): Promise<void> {
  return invoke("unset_project_config_value", { projectRoot, path });
}

/** Validate + overwrite the whole global file (raw editor Save). Rejects invalid TOML. */
export function writeConfigText(text: string): Promise<void> {
  return invoke("write_config_text", { text });
}

/** Overwrite the global file with the commented default template. */
export function resetConfig(): Promise<void> {
  return invoke("reset_config", {});
}

/** Raw text of the global config file (the default template if it doesn't exist yet). */
export function readConfigText(): Promise<string> {
  return invoke("read_config_text", {});
}

/** Resolved global + (optional) per-project config file paths, for "Reveal in Finder". */
export function configFilePaths(projectRoot?: string | null): Promise<ConfigPaths> {
  return invoke("config_file_paths", { projectRoot: projectRoot ?? null });
}

/** Subscribe to live-reload events (fired on hand-edit, in-app write, or reset). Returns the
 *  unlisten fn. Handlers MUST be idempotent — an in-app write emits this twice (the write path
 *  plus the file watcher); the frontend just re-pulls, so duplicates are harmless. */
export function onConfigChanged(cb: (eff: EffectiveConfig) => void): Promise<UnlistenFn> {
  return listen<EffectiveConfig>("config-changed", (e) => cb(e.payload));
}
