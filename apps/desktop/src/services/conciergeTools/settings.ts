// The SETTINGS tool domain for the concierge — the parts of the ⋯ Settings dialog that
// `get_config` / `set_config` cannot see or cannot reach.
//
// Those two ops already cover most of the dialog: nearly every control writes one dotted key into
// the global `config.toml`, and `get_config` reads the merged result back. This module exists for
// the two categories they miss, both of which are whole panes rather than stray checkboxes.
//
// GAP 1 — PER-PROJECT CONFIG WAS UNREACHABLE. `set_config` writes the GLOBAL file only. Rust has
//   had `set_project_config_value` / `unset_project_config_value` since the editable-config work
//   and services/configActions uses them, but nothing exposed them to a caller. The visible
//   consequence is the Approvals pane: `setApprovalRule(cat, rule, "project", root)`,
//   `removeApprovalRuleEverywhere(cat, root)` and `setResumeRule(rule, "project", root)` all take a
//   `"project"` scope that no tool caller could ask for, so "auto-approve edits in THIS repo only"
//   — the safest way to use auto-approve at all — was human-only. `readProjectConfig`,
//   `setProjectConfig` and `unsetProjectConfig` close that, by dotted path, with the project root
//   as an EXPLICIT required argument (see "the root is never inferred" below).
//
//   A third op rides along because it is the same gap on the other file: the global config has a
//   setter and no UNSETTER. `unset_config_value` exists in Rust and is unreachable, and some
//   settings have no other way back to their default — `workers.max_concurrent` returns to AUTO by
//   REMOVING the key, because writing a number always pins it. `unsetGlobalConfig` closes that.
//
// GAP 2 — SETTINGS THAT ARE NOT DOTTED CONFIG PATHS AT ALL. Auditing the dialog pane by pane turns
//   up controls whose state lives in a zustand store, a persisted localStorage blob, or behind a
//   bespoke command, and which `get_config` therefore cannot even REPORT, let alone change. The full
//   audit — including the ones deliberately left unreachable, with the reason — is
//   `UNMAPPED_SETTINGS` below, and `listUnmappedSettings()` hands it to a caller so the concierge
//   can say "I can't change that, and here's why" instead of writing a config key that does nothing.
//
// FOUR CONTRACTS, matching services/conciergeTools/workspace.ts, and enforced rather than documented:
//
// 1. TYPED RESULTS, NEVER THROWN STRINGS. Every function returns `SettingsResult<T>`: an `ok` value,
//    or a refusal carrying a machine-readable `reason` plus a sentence the concierge can say out
//    loud. Async operations catch their backend rejection and return `backend-failed`; nothing here
//    rejects. This matters more here than elsewhere because the config commands reject on a
//    MALFORMED KEY, and "toml parse error at line 4" is not something to hand a user raw.
//
// 2. AN EXHAUSTIVE RISK MAP. `SettingsOp` is derived from `SETTINGS_OPS`, and `SETTINGS_OP_RISK` is
//    a `Record<SettingsOp, SettingsRiskClass>` — adding an operation without classifying it is a
//    `tsc` failure. Every result carries the risk of the operation actually performed, which is why
//    `setProjectConfig` can report itself as either `set_project_config` or `widen_approvals`.
//
// 3. NO NATIVE MODAL IS EVER OPENED FROM HERE. Nothing calls `pick_folder`, `pick_files`, or a
//    confirm dialog. An AI caller cannot answer an NSOpenPanel and the concierge bridge round-trip
//    has a 600s ceiling, so a picker opened from a tool call is a guaranteed hang with a modal left
//    on the user's screen. Project roots arrive as explicit absolute strings, validated here. The
//    test asserts this module never imports services/dialog.
//
// 4. WIDENING WHAT AGENTS MAY DO WITHOUT ASKING NEEDS AN EXPLICIT `confirm: true`. Auto-approve is
//    the one setting in this domain where a mis-parsed instruction has consequences outside the
//    settings file: an `approvals.bash = "always"` written by accident means every future agent runs
//    every command it likes without asking. So a permissive approvals write — and, equally, DROPPING
//    a rule that was holding a category back — refuses without `confirm: true` and reports itself as
//    the `widen_approvals` operation.
//
//    THE DEFAULTS ARE PERMISSIVE, WHICH IS WHY "REMOVING A KEY" IS NOT AUTOMATICALLY THE SAFE
//    DIRECTION. `ApprovalsConfig::default()` in src-tauri/src/config.rs ships all six categories as
//    `"always"` — bash included — and `[ai].auto_approve` defaults `true`. So unsetting a GLOBAL
//    `approvals.bash = "never"` does not return the user to "ask": it hands every agent on the
//    machine unattended command execution. Those unsets are classified `widen_approvals` too, and
//    say so in the refusal. (`approvals.resume` is the exception in that table: it defaults to
//    `"ask"`, so removing it is genuinely restrictive at global scope.) Every other global unset is
//    `destructive` — the previous value is not recoverable once the key is gone.
//
//    A RESIDUAL BYPASS, stated rather than papered over: the pre-existing `set_config` control op
//    writes the GLOBAL file with no gate at all, so a caller that wants `approvals.bash = "always"`
//    machine-wide can still get it without confirming. Closing that means changing the `set_config`
//    boundary, which lives outside this module (services/controlListener). Until it is closed, this
//    module's gate raises the cost of the accident, it does not make it impossible.
//
// THE PROJECT ROOT IS NEVER INFERRED. Every per-project function takes `projectRoot` as a required
// argument and validates it. Reading it from `projectStore.selectedProjectId` would be more
// convenient and is exactly the wrong shape: the concierge runs while the human clicks around, so
// "the current project" at the moment a tool call is dispatched is not necessarily the one the
// human was talking about — and the failure mode is writing an auto-approve rule into the wrong
// repository, silently.
//
// DELIBERATELY ABSENT — the destructive whole-file operations, for the same reason workspace.ts
// leaves them out: `write_config_text` replaces the entire global file (every comment and every key
// the caller did not know about), and `reset_config` overwrites it with the default template. Both
// are one call away from erasing a configuration the user built up by hand, and neither has a
// per-key alternative that would make the blast radius visible in the request. See
// `UNMAPPED_SETTINGS` for the rest of what was left out and why.
import {
  getConfig as getConfigBackend,
  setProjectConfigValue as setProjectConfigValueBackend,
  unsetProjectConfigValue as unsetProjectConfigValueBackend,
  unsetConfigValue as unsetConfigValueBackend,
  type SparkleConfig,
} from "../config";
import { useSettingsStore } from "../../stores/settingsStore";
import { useKeybindingsStore, SHORTCUT_DEFAULTS, SHORTCUT_LABELS, type ShortcutId } from "../../stores/keybindingsStore";
import { useUiStore, type CategoryId, type ThemePref, type ZoomColumn } from "../../stores/uiStore";
import { formatBinding, type KeyBinding, type ModifierName } from "../../keyboardHints/keybindings";
import { APPROVAL_CATEGORIES, type ApprovalCategory } from "../suggestions/approvalCategories";
import type { AgentTabStatus } from "../../types";

// ---------------------------------------------------------------------------------------------
// Operations + risk
// ---------------------------------------------------------------------------------------------

/** Every operation this domain offers. The source of the `SettingsOp` union — add here and the risk
 *  map below stops compiling until the new operation is classified. */
export const SETTINGS_OPS = [
  // GAP 1 — the per-project config layer, plus the global file's missing unset.
  "read_project_config",
  "set_project_config",
  "unset_project_config",
  "widen_approvals",
  "unset_global_config",
  // GAP 2 — settings whose state is not a dotted config path.
  "list_unmapped_settings",
  "read_appearance",
  "list_notification_rules",
  "set_notification_rule",
  "list_keyboard_shortcuts",
  "set_keyboard_shortcut",
  "reset_keyboard_shortcut",
  "set_auto_apply_updates",
  "open_settings_pane",
] as const;

export type SettingsOp = (typeof SETTINGS_OPS)[number];

/**
 * How much a caller should think before invoking an operation.
 *
 * The four classes are NOT workspace.ts's four, deliberately. That domain's `disruptive` ("stops
 * work in flight") and `irreversible` ("destroys something the app cannot put back") describe
 * running processes and folders on disk; nothing here has a PTY or a directory. What this domain
 * actually risks is different in kind, so it says so in its own words:
 *
 *  • `read-only`   — observes; changes nothing.
 *  • `routine`     — changes a preference the user can flip straight back, with the old value still
 *                    on screen. Every non-approvals write lives here.
 *  • `permissive`  — WIDENS what agents may do without asking a human. Its consequences land outside
 *                    the settings file, on every future agent turn, and the user is not present when
 *                    they do. Requires `confirm: true`.
 *  • `destructive` — removes configuration the app cannot reconstruct, because the value that was
 *                    there is gone once the key is. Requires `confirm: true`.
 */
export type SettingsRiskClass = "read-only" | "routine" | "permissive" | "destructive";

/**
 * The classification. EXHAUSTIVE by construction: `Record<SettingsOp, SettingsRiskClass>` means an
 * operation added to `SETTINGS_OPS` without a line here fails `tsc`.
 *
 * Three entries carry their reasoning:
 *  • `widen_approvals` is the op `setProjectConfig`/`unsetProjectConfig` report when the write would
 *    let agents act without asking. It is not a separate function — it is what those functions are
 *    DOING in that case, and the caller sees the higher class it actually invoked.
 *  • `unset_global_config` is `destructive` while `unset_project_config` is `routine`. Dropping a
 *    project override falls the project back to the global rule, which is still written down
 *    somewhere; dropping a global key leaves nothing behind at all.
 *  • `open_settings_pane` is `routine` rather than `read-only` — it puts a modal on the human's
 *    screen over whatever they were doing.
 */
export const SETTINGS_OP_RISK: Record<SettingsOp, SettingsRiskClass> = {
  read_project_config: "read-only",
  list_unmapped_settings: "read-only",
  read_appearance: "read-only",
  list_notification_rules: "read-only",
  list_keyboard_shortcuts: "read-only",
  set_project_config: "routine",
  unset_project_config: "routine",
  set_notification_rule: "routine",
  set_keyboard_shortcut: "routine",
  reset_keyboard_shortcut: "routine",
  set_auto_apply_updates: "routine",
  open_settings_pane: "routine",
  widen_approvals: "permissive",
  unset_global_config: "destructive",
};

// ---------------------------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------------------------

/** Why an operation refused. Machine-readable so a caller can branch; the accompanying `message` is
 *  what the concierge says to the human. */
export type SettingsRefusalReason =
  | "invalid-path" // the project root was blank, relative, or unexpanded (`~`)
  | "invalid-key" // not a dotted config key (`workers.max_concurrent`, `approvals.bash`)
  | "invalid-value" // not a TOML scalar — the config layer stores nothing else
  | "not-found" // the dotted key resolves to nothing in the effective config
  | "unknown-setting" // an unknown status / shortcut id / settings pane
  | "unsupported-binding" // a key binding this shortcut could never match (see setKeyboardShortcut)
  | "confirmation-required" // permissive or destructive, and the caller did not say `confirm: true`
  | "backend-failed"; // the Rust side rejected — the message carries its text

export interface SettingsOk<T> {
  ok: true;
  /** The operation actually performed (not necessarily the function's name — see setProjectConfig). */
  op: SettingsOp;
  risk: SettingsRiskClass;
  value: T;
}

export interface SettingsRefusal {
  ok: false;
  op: SettingsOp;
  risk: SettingsRiskClass;
  reason: SettingsRefusalReason;
  /** A sentence fit to say to the user. Never an exception, never a bare error string. */
  message: string;
}

export type SettingsResult<T> = SettingsOk<T> | SettingsRefusal;

function ok<T>(op: SettingsOp, value: T): SettingsOk<T> {
  return { ok: true, op, risk: SETTINGS_OP_RISK[op], value };
}

function refuse(op: SettingsOp, reason: SettingsRefusalReason, message: string): SettingsRefusal {
  return { ok: false, op, risk: SETTINGS_OP_RISK[op], reason, message };
}

/** Backend rejections arrive as `Error`, as a bare string (Tauri's own rejection shape), or as
 *  anything else a command chose to throw. Flatten to something quotable. */
function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export interface ConfirmOption {
  /** Must be `true`. Permissive and destructive operations refuse without it so a mis-parsed
   *  instruction cannot widen auto-approval or drop a config key by default. */
  confirm: boolean;
}

// ---------------------------------------------------------------------------------------------
// Injectable backend edge
// ---------------------------------------------------------------------------------------------

/** The config commands this domain calls. Injected so the tests can assert them without a Tauri
 *  host — the same seam workspace.ts's `WorkspaceDeps` uses. NOTHING here opens a dialog; see
 *  contract 3 above. Note what is NOT in this interface: `writeConfigText` and `resetConfig`, so a
 *  future operation cannot reach a whole-file overwrite even by accident. */
export interface SettingsDeps {
  getConfig(projectRoot: string | null): Promise<{ config: SparkleConfig; warnings: string[] }>;
  setProjectConfigValue(projectRoot: string, path: string, value: ConfigScalar): Promise<void>;
  unsetProjectConfigValue(projectRoot: string, path: string): Promise<void>;
  unsetGlobalConfigValue(path: string): Promise<void>;
}

export function defaultSettingsDeps(): SettingsDeps {
  return {
    getConfig: (projectRoot) => getConfigBackend(projectRoot),
    setProjectConfigValue: (projectRoot, path, value) =>
      setProjectConfigValueBackend(projectRoot, path, value),
    unsetProjectConfigValue: (projectRoot, path) =>
      unsetProjectConfigValueBackend(projectRoot, path),
    unsetGlobalConfigValue: (path) => unsetConfigValueBackend(path),
  };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/** What a TOML config key can hold. The Rust config layer is scalar-only; an array or an object
 *  would be rejected there, so it is rejected here where the message can say what to pass instead. */
export type ConfigScalar = boolean | number | string;

/** An absolute POSIX/Windows path, already expanded. We validate rather than prompt: a picker is
 *  unavailable to an AI caller (contract 3), so a bad root has to come back as a refusal that says
 *  what a good one looks like. `~` is rejected explicitly — the shell expands it, `invoke` does not,
 *  and passing it through would write a config file into a literal `~` directory. */
function rootProblem(projectRoot: string): string | null {
  const trimmed = projectRoot.trim();
  if (!trimmed) {
    return "A project root is required — pass the project's absolute path, e.g. /Users/you/code/app.";
  }
  if (trimmed.startsWith("~")) {
    return `"${trimmed}" starts with ~, which nothing here expands. Pass the fully-expanded absolute path.`;
  }
  if (!/^(\/|[A-Za-z]:[\\/])/.test(trimmed)) {
    return `"${trimmed}" is not an absolute path. Pass the project's absolute path, e.g. /Users/you/code/app.`;
  }
  return null;
}

/** Normalize a validated root the same way workspace.ts does, so the two agree on what "the same
 *  project" means: trailing separators dropped, but never the leading one of `/`. */
function normalizeRoot(projectRoot: string): string {
  // WITHOUT A LOOKBEHIND, deliberately (safari14 build target — a lookbehind assertion is a PARSE
  // error there, taking out this whole module and everything importing it; roborev 54174 / me54).
  // The `|| trimmed.slice(0, 1)` preserves a bare root (`/`, `C:\`) exactly as the `(?<=.)` did.
  const trimmed = projectRoot.trim();
  return trimmed.replace(/[/\\]+$/, "") || trimmed.slice(0, 1);
}

/**
 * A dotted config key: at least a section and a leaf (`workers.max_concurrent`, `workflow.drift.
 * behind_nudge`). Bare `workers` is refused — the config layer stores scalars at leaves, so a
 * section-level write has nowhere to land, and a section-level UNSET would silently delete every
 * key under it.
 */
function keyProblem(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return "A dotted config key is required, e.g. approvals.bash or workers.max_concurrent.";
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(trimmed)) {
    return `"${trimmed}" is not a dotted config key. Pass section.key, e.g. approvals.bash or workflow.require_pr.`;
  }
  // Rejected HERE so every caller inherits the guard, rather than each object walk remembering it.
  // The regex above admits `__proto__` and `constructor`, and a dotted walk over a plain object
  // resolves them off Object.prototype: `readProjectConfig(root, "__proto__.constructor")` would
  // come back `ok` with a FUNCTION as the config value, and `workflow.__proto__` `ok` with `{}` —
  // a key the config has never heard of, reported as set, with a function in the payload the
  // concierge relays. No real TOML key is named any of these.
  if (PROTOTYPE_SEGMENTS.some((bad) => trimmed.split(".").includes(bad))) {
    return `"${trimmed}" contains a reserved JavaScript property name (${PROTOTYPE_SEGMENTS.join(", ")}); no config key is called that.`;
  }
  return null;
}

const PROTOTYPE_SEGMENTS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** A scalar the config layer can actually store. `NaN`/`Infinity` are rejected here rather than
 *  serialized into TOML as something no parser will read back. */
function valueProblem(value: unknown): string | null {
  if (typeof value === "boolean" || typeof value === "string") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : "A config number has to be finite.";
  }
  return `Config values are TOML scalars — pass a string, number, or boolean, not ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}.`;
}

// ---------------------------------------------------------------------------------------------
// GAP 1 — per-project config, and the global unset
// ---------------------------------------------------------------------------------------------

/** The `[approvals]` keys a permissive value can be written to: the six rule categories plus the
 *  session-resume rule, which is a sibling under the same table with its own value domain.
 *  DERIVED from `APPROVAL_CATEGORIES` so a category added there is covered here automatically —
 *  a hand-copied list would leave a new category's widening unguarded and silent. */
const APPROVAL_KEYS: readonly string[] = [
  ...APPROVAL_CATEGORIES.map((c: ApprovalCategory) => `approvals.${c}`),
  "approvals.resume",
];

/** Is this dotted key one of the auto-approve rules? */
function isApprovalKey(path: string): boolean {
  return APPROVAL_KEYS.includes(path.trim());
}

/**
 * The ONLY sections a per-project `.sparkle/config.toml` actually takes effect in — the exact set
 * the Rust merge applies in its project arm (config.rs, `if let Some(text) = project`).
 *
 * An ALLOWLIST rather than a denylist, and that is the load-bearing choice. The Rust side does not
 * validate what it is handed: `set_project_value` renders the edited document and runs it through
 * `parse_layer`, which — per its own contract at config.rs:2056 — "ignores unknown keys, errors on
 * bad types/syntax". So `workers.max_concurrent`, a section this layer skips, and `workflow.
 * requre_pr`, a typo inside one it honors, are BOTH written to the file, parse cleanly, produce no
 * warning, and change nothing. There is no rejection coming back for this module to forward.
 *
 * Which makes forwarding an unrecognised section precisely the GAP-2 failure this module exists to
 * prevent — a write that succeeds and a setting that does not move — committed by the module
 * itself. The cost of the allowlist is that a section added on the Rust side needs an edit here
 * before it is drivable; a stale refusal that names the honored set is a far better failure than a
 * silent one.
 */
/** `[preview]` keys that ARE mirrored into the merged config, so this tool can read them back. */
const PREVIEW_MERGED_KEYS: readonly string[] = [
  "preview.enabled",
  "preview.idle_grace_min",
  // `auto_open` was here until 2026-08-19. It governed when a preview PANE opened unasked, and the
  // pane was removed in favour of a card in the concierge chat — a card surfaces itself, so there
  // was nothing left for it to decide. Listing a key the merged config no longer carries would make
  // this tool report a setting that reads back as undefined, which is the stale-allowlist failure
  // the note above is about, pointed the other way.
  "preview.agent_eagerness",
];

/** `[preview]` detection overrides — read off the project file directly by `preview.rs`, never
 *  merged into `SparkleConfig`, so this tool must not pretend to own them. See the refusal in
 *  `projectSectionProblem`. */
const PREVIEW_HAND_WRITTEN_KEYS: readonly string[] = [
  "preview.command",
  "preview.args",
  "preview.path",
  "preview.port",
];

const PROJECT_HONORED_SECTIONS: readonly string[] = [
  "workflow",
  "plugins",
  "freshness",
  // Which PR-scoped reviewer watches a repo is a property of the REPO — one machine routinely works
  // on repos that have one and repos that do not — so `apply_review` runs in BOTH arms of
  // build_effective (config.rs) and this entry keeps the concierge from refusing a write Rust honors.
  "review",
  "worktree_pool",
  // Whether a project is worth previewing — and how eagerly — is a property of the project, so
  // `apply_preview` runs in BOTH arms of build_effective (config.rs). Without this entry the
  // concierge refuses a write that Rust would honor: exactly the stale refusal the note above
  // predicts, and the failure it exists to prevent.
  "preview",
  "approvals",
  "done",
  "delivered",
];

/** The machine-wide sections, with the reason each one is machine-wide. Not the refusal rule — that
 *  is `PROJECT_HONORED_SECTIONS` above — just better wording for the seven cases a caller is most
 *  likely to try, since "set it globally instead" is actionable and "not honored here" is not. */
const PROJECT_IGNORED_SECTIONS: Record<string, string> = {
  workers: "concurrency is machine-wide",
  ai: "the AI feature switches are machine-wide",
  tools: "the tool switches are machine-wide",
  roborev: "the roborev consent flag is machine-wide",
  onepassword: "the vault belongs to your 1Password account, not to one repo",
  capture: "the capture shortcut is machine-wide",
  voice: "the microphone selection is machine-wide, not per-repo",
};

/**
 * The reason a dotted key cannot be SET in a project file, or null when it can.
 *
 * TWO LEVELS, and the second one is deliberately partial:
 *
 *  • SECTION — the allowlist above. Complete, because the honored set is seven names.
 *  • KEY, for `[approvals]` only. `approvals.bahs = "never"` would otherwise pass every check,
 *    write cleanly, be skipped in silence, and come back `ok` — leaving a caller convinced it had
 *    pinned a category for the repo while the repo keeps running under the permissive global
 *    default. That is the worst instance of this failure in the module, and it is also the one it
 *    can check for free: `APPROVAL_KEYS` is derived from `APPROVAL_CATEGORIES`, which this module
 *    already owns.
 *
 * RESIDUAL GAP, stated rather than implied: key-level typos in the OTHER honored sections are not
 * caught. `workflow.requre_pr` is written, parses clean, warns about nothing, and changes nothing,
 * and this returns `ok` for it. Closing that would mean either enumerating every leaf of the config
 * schema here — a second copy of a schema that lives in Rust, and the exact re-derivation this
 * module is built to avoid — or round-tripping `getConfig` after every write to see whether the
 * value took. Neither is worth it for a typo in a key the caller chose; the approvals case is
 * carved out because there the silent no-op is a SAFETY belief, not a preference.
 *
 * Deliberately not applied to the unset arm: removing a key is cleanup, and a machine-wide or
 * misspelled key can already be sitting in a project file (hand-written, left by an older build,
 * or written by this tool before this check existed). Refusing to delete it would strand it there.
 */
function projectSectionProblem(path: string, value?: unknown): string | null {
  const key = path.trim();
  // `[preview].enabled` may only NARROW at project scope: config.rs's `apply_preview` ignores a
  // project `true` so a cloned repo cannot re-enable a preview the user turned off globally. A
  // write of `true` here would therefore land in the file and change nothing — the silent no-op
  // this module exists to prevent, and the same shape as the `[approvals]` carve-out above, where
  // the caller's belief is about safety rather than preference.
  //
  // THE COPY STATES ONLY WHAT IS INVARIANT. It used to add "cannot turn it back on for a user who
  // disabled it globally. Set it in the global config instead." — which asserts a global state this
  // function never reads, and the preview is ON by default. A user whose preview is already on,
  // asking to pin it for one project, was told a fact about their config that was false and sent to
  // change a setting that already had the value they wanted. `config.rs`'s sibling warning was
  // narrowed to fire only when the preview really is globally off; this path cannot make that
  // distinction (it has no effective value in hand), so it says the thing that is true either way:
  // a project file cannot RAISE `preview.enabled`, so writing `true` there is a no-op at any global
  // setting.
  if (key === "preview.enabled" && value === true) {
    return "preview.enabled = true is a no-op in a project's .sparkle/config.toml — a project file can only turn the preview OFF for itself, never on, so writing true there would land in the file and change nothing. If the preview is already enabled globally (the default), this project already has it.";
  }
  const section = key.split(".")[0] ?? "";
  if (section === "approvals" && !isApprovalKey(key)) {
    return `${key} is not an auto-approve rule. The rules are: ${APPROVAL_KEYS.join(", ")}.`;
  }
  // `[preview]` is the first honored section whose keys are NOT all mirrored into the merged
  // SparkleConfig, so the section-level allowlist above cannot see the difference. The detection
  // overrides are read straight off the project's own file by preview.rs and never reach
  // `PreviewConfig`, so a write here would pass every check, land in the file, and then be
  // reported back as UNSET by readProjectConfig — which walks the effective config and would
  // truthfully find nothing. Writing the founder's primary escape hatch and then telling him it
  // is not set is worse than declining.
  //
  // `args` could not be written at all regardless: valueProblem rejects arrays, and the documented
  // form is `args = ["run", "dev:web"]`. Refusing all four together keeps the story consistent
  // rather than half-supporting the section.
  if (section === "preview" && PREVIEW_HAND_WRITTEN_KEYS.includes(key)) {
    return `${key} is a detection override that Sparkle reads straight from the project's .sparkle/config.toml — it is not part of the merged config, so writing it here would report back as unset. Edit that file by hand. The keys this tool can set are: ${PREVIEW_MERGED_KEYS.join(", ")}.`;
  }
  if (PROJECT_HONORED_SECTIONS.includes(section)) return null;
  // `hasOwnProperty`, not a bare index: `"constructor.foo"` and `"__proto__.foo"` pass keyProblem's
  // regex, and a bare lookup would resolve them off Object.prototype and splice a function body
  // into the sentence the concierge reads out.
  const why = Object.prototype.hasOwnProperty.call(PROJECT_IGNORED_SECTIONS, section)
    ? PROJECT_IGNORED_SECTIONS[section]
    : undefined;
  if (why) {
    return `[${section}] is ignored in a project's .sparkle/config.toml — ${why}. Set ${key} in the global config instead.`;
  }
  return `[${section}] is not honored in a project's .sparkle/config.toml — the key would be written, silently skipped, and change nothing. Project-scoped sections are: ${PROJECT_HONORED_SECTIONS.join(", ")}.`;
}

/**
 * Would REMOVING this key from the GLOBAL file leave agents freer than they were?
 *
 * It usually would, and that is the trap: Sparkle's shipped defaults are permissive.
 * `ApprovalsConfig::default()` sets all six categories to `"always"` and `[ai].auto_approve`
 * defaults `true`, so a user who wrote `approvals.bash = "never"` is being held back BY that key —
 * deleting it restores `"always"` machine-wide.
 *
 * `approvals.resume` is deliberately not in this set: it defaults to `"ask"`, so removing it is the
 * restrictive direction.
 */
function globalUnsetWidens(path: string): boolean {
  const key = path.trim();
  if (key === "ai.auto_approve") return true;
  return APPROVAL_CATEGORIES.some((c: ApprovalCategory) => key === `approvals.${c}`);
}

/**
 * Would writing `value` at `path` let agents act WITHOUT asking a human?
 *
 * `"always"` on a category auto-answers that category's permission prompts. `"summary"`/`"full"` on
 * the resume rule auto-answer the session-resume prompt. `"never"` and `"ask"` are the restrictive
 * directions and stay routine — a caller narrowing what agents may do does not need a gate.
 */
function isPermissiveApproval(path: string, value: ConfigScalar): boolean {
  const key = path.trim();
  if (key === "approvals.resume") return value === "summary" || value === "full";
  return isApprovalKey(key) && value === "always";
}

/** Walk a dotted key through the effective config. Returns `undefined` for a key that is absent or
 *  that runs off a leaf (`workers.max_concurrent.nope`).
 *
 *  OWN properties only. `keyProblem` already rejects the prototype segment names before any caller
 *  reaches here, but this walk is the thing that would leak an inherited value, so it carries its
 *  own guard rather than depending on a validation that lives two functions away. */
function valueAtPath(config: SparkleConfig, path: string): unknown {
  let node: unknown = config;
  for (const seg of path.trim().split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, seg)) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

export interface ProjectConfigRead {
  projectRoot: string;
  /** The dotted key that was asked for, or null when the whole config was requested. */
  path: string | null;
  /** The value at `path`, or the entire effective config when `path` was omitted. */
  value: unknown;
  /** Non-fatal load warnings (a malformed layer, keys ignored at project scope). Worth repeating to
   *  the user: a project file that failed to parse reads exactly like one with nothing in it. */
  warnings: string[];
}

/**
 * Read a project's EFFECTIVE config — the global file with that project's `.sparkle/config.toml`
 * layered over it, which is what the app actually obeys inside that project.
 *
 * This is the read half of gap 1, and it is not the same question `get_config` answers. That op
 * passes no root, so it returns the GLOBAL layer; a concierge using it to check "is auto-approve on
 * for this repo?" gets the machine-wide answer and confidently reports the wrong one wherever a
 * project overrides it.
 *
 * With `path`, the single value is resolved and an absent key is a `not-found` refusal rather than
 * an `ok` carrying `undefined` — "the key is not set" and "the key is set to nothing" are different
 * facts and a caller must be able to tell them apart.
 */
export async function readProjectConfig(
  projectRoot: string,
  path?: string | null,
  deps: SettingsDeps = defaultSettingsDeps(),
): Promise<SettingsResult<ProjectConfigRead>> {
  const problem = rootProblem(projectRoot);
  if (problem) return refuse("read_project_config", "invalid-path", problem);
  const root = normalizeRoot(projectRoot);

  const key = path?.trim() ?? "";
  if (key) {
    const keyIssue = keyProblem(key);
    if (keyIssue) return refuse("read_project_config", "invalid-key", keyIssue);
    // The MIRROR of the write-side carve-out, and it fixes a false statement rather than a
    // missing feature. These four keys are read straight off the project's .sparkle/config.toml
    // by the detector and are deliberately absent from the merged SparkleConfig, so the generic
    // path below walks the effective config, finds nothing, and reports "…is not set for <root>
    // — neither the project file nor the global one has it." That is flatly FALSE for a project
    // file that carries the override — and since the write path now refuses these keys, hand
    // editing is the ONLY supported way to set them, so the false report is on the supported
    // path rather than an edge case.
    if (PREVIEW_HAND_WRITTEN_KEYS.includes(key)) {
      return refuse(
        "read_project_config",
        "invalid-key",
        `${key} is a detection override read straight from the project's .sparkle/config.toml by Sparkle's previewability detector — it is not part of the merged config this tool can see, so it cannot report whether it is set. Open that file to check. The [preview] keys this tool can read are: ${PREVIEW_MERGED_KEYS.join(", ")}.`,
      );
    }
  }

  let effective: { config: SparkleConfig; warnings: string[] };
  try {
    effective = await deps.getConfig(root);
  } catch (e) {
    return refuse("read_project_config", "backend-failed", `Could not read the config for ${root}: ${describe(e)}`);
  }

  if (!key) {
    return ok("read_project_config", {
      projectRoot: root,
      path: null,
      value: effective.config,
      warnings: effective.warnings,
    });
  }

  const value = valueAtPath(effective.config, key);
  if (value === undefined) {
    return refuse(
      "read_project_config",
      "not-found",
      `${key} is not set for ${root} — neither the project file nor the global one has it.`,
    );
  }
  return ok("read_project_config", { projectRoot: root, path: key, value, warnings: effective.warnings });
}

export interface ProjectConfigWrite {
  projectRoot: string;
  path: string;
  value: ConfigScalar;
}

/**
 * Write one dotted key into a project's `.sparkle/config.toml` — the "this project" scope the
 * Approvals pane has always had and no caller could reach.
 *
 * A façade over services/config's `setProjectConfigValue`, which is the same comment-preserving
 * Rust write services/configActions performs when a human clicks the pane. Nothing here re-derives
 * where the file lives, how TOML is merged, or which keys a project layer is allowed to hold — the
 * Rust config layer owns all three and rejects what it will not take, which arrives back as a
 * `backend-failed` refusal rather than an exception.
 *
 * PERMISSIVE WRITES ARE GATED. `approvals.bash = "always"` in a repo means every future agent in
 * that repo runs every command it likes without asking, and the human is not there when it happens.
 * So a permissive approvals value refuses without `confirm: true` and reports itself as
 * `widen_approvals` (risk `permissive`) rather than as a routine key write. Restrictive values
 * (`"never"`, `"ask"`) and every non-approvals key stay routine — narrowing needs no ceremony.
 *
 * NOT updated here: the optimistic `approvalsStore` cache that configActions writes before its own
 * round-trip. That cache is kept fresh from the file by `useSyncProjectApprovals`, and writing it
 * from a tool call would put a second, unsynchronized author on a store whose whole contract is
 * "config.toml is the source of truth". The file is written; the app re-reads it.
 */
export async function setProjectConfig(
  projectRoot: string,
  path: string,
  value: ConfigScalar,
  opts: Partial<ConfirmOption> = {},
  deps: SettingsDeps = defaultSettingsDeps(),
): Promise<SettingsResult<ProjectConfigWrite>> {
  const widening = isPermissiveApproval(path, value);
  const op: SettingsOp = widening ? "widen_approvals" : "set_project_config";

  const problem = rootProblem(projectRoot);
  if (problem) return refuse(op, "invalid-path", problem);
  const root = normalizeRoot(projectRoot);

  const keyIssue = keyProblem(path) ?? projectSectionProblem(path, value);
  if (keyIssue) return refuse(op, "invalid-key", keyIssue);
  const key = path.trim();

  const valueIssue = valueProblem(value);
  if (valueIssue) return refuse(op, "invalid-value", valueIssue);

  if (widening && !opts.confirm) {
    return refuse(
      op,
      "confirmation-required",
      `Setting ${key} to "${String(value)}" in ${root} lets agents there act without asking you first. Re-issue with confirm: true.`,
    );
  }

  try {
    await deps.setProjectConfigValue(root, key, value);
  } catch (e) {
    return refuse(op, "backend-failed", `Could not write ${key} for ${root}: ${describe(e)}`);
  }
  return ok(op, { projectRoot: root, path: key, value });
}

/**
 * Remove one dotted key from a project's `.sparkle/config.toml`, so the project falls back to the
 * global value. A no-op when the file or the key is absent — that is the Rust command's own
 * contract, and it is the right one: "make this project stop overriding X" succeeds when there was
 * no override.
 *
 * GATED FOR APPROVALS, and this is the case that is easy to get wrong. Dropping an override is
 * usually the safe direction, but not here: a project sitting on `approvals.bash = "never"` to hold
 * a repo back is relying on the override, and removing it hands the repo whatever the global rule
 * says — which may well be `"always"`. Losing a restriction is a widening even though the call
 * looks like a deletion, so any `approvals.*` unset reports as `widen_approvals` and needs
 * `confirm: true`. We do not read the global rule first to decide: that would make the gate depend
 * on a value that can change between the check and the write.
 */
export async function unsetProjectConfig(
  projectRoot: string,
  path: string,
  opts: Partial<ConfirmOption> = {},
  deps: SettingsDeps = defaultSettingsDeps(),
): Promise<SettingsResult<{ projectRoot: string; path: string }>> {
  const widening = isApprovalKey(path);
  const op: SettingsOp = widening ? "widen_approvals" : "unset_project_config";

  const problem = rootProblem(projectRoot);
  if (problem) return refuse(op, "invalid-path", problem);
  const root = normalizeRoot(projectRoot);

  // Only `keyProblem` here — NOT `projectSectionProblem`. Deleting a key the layer ignores is
  // harmless cleanup, and this is the only way to get one out of a project file once it is there.
  const keyIssue = keyProblem(path);
  if (keyIssue) return refuse(op, "invalid-key", keyIssue);
  const key = path.trim();

  if (widening && !opts.confirm) {
    return refuse(
      op,
      "confirmation-required",
      `Removing ${key} from ${root} drops this project's own rule, so it falls back to your global one — which may be more permissive. Re-issue with confirm: true.`,
    );
  }

  try {
    await deps.unsetProjectConfigValue(root, key);
  } catch (e) {
    return refuse(op, "backend-failed", `Could not remove ${key} from ${root}: ${describe(e)}`);
  }
  return ok(op, { projectRoot: root, path: key });
}

/**
 * Remove one dotted key from the GLOBAL config file, restoring Sparkle's built-in default for it.
 *
 * The setter half of this has always been reachable (`set_config`); the unsetter has not, and for
 * some settings REMOVING the key is the only way to express the default — `workers.max_concurrent`
 * is absent-means-AUTO (derived from the machine), and any number pins it, so there is no value you
 * can write to get auto back.
 *
 * TWO RISK CLASSES, because "restore the default" is not one kind of act here. Sparkle's defaults
 * are deliberately permissive (see contract 4): the six `[approvals]` categories ship `"always"` and
 * `[ai].auto_approve` ships `true`. So removing a global `approvals.bash = "never"` — the setting a
 * user reaches for precisely to stop unattended command execution — restores `"always"` for every
 * agent on the machine. Those keys report as `widen_approvals` (risk `permissive`) with a message
 * that says what the agents gain; everything else reports as `unset_global_config` (risk
 * `destructive`), which is about the value being unrecoverable rather than about permissions.
 *
 * Either way `confirm: true` is required. Unlike a project unset, there is no lower layer still
 * holding a copy of what was there.
 */
export async function unsetGlobalConfig(
  path: string,
  opts: ConfirmOption,
  deps: SettingsDeps = defaultSettingsDeps(),
): Promise<SettingsResult<{ path: string }>> {
  const widening = globalUnsetWidens(path);
  const op: SettingsOp = widening ? "widen_approvals" : "unset_global_config";

  const keyIssue = keyProblem(path);
  if (keyIssue) return refuse(op, "invalid-key", keyIssue);
  const key = path.trim();

  if (!opts.confirm) {
    return refuse(
      op,
      "confirmation-required",
      widening
        ? `Removing ${key} from your global config restores Sparkle's default, which is PERMISSIVE — agents everywhere on this machine would act without asking you first. Re-issue with confirm: true.`
        : `Removing ${key} from your global config resets it to Sparkle's default and discards the value you had. Re-issue with confirm: true.`,
    );
  }

  try {
    await deps.unsetGlobalConfigValue(key);
  } catch (e) {
    return refuse(op, "backend-failed", `Could not remove ${key}: ${describe(e)}`);
  }
  return ok(op, { path: key });
}

// ---------------------------------------------------------------------------------------------
// GAP 2 — the audit of settings that are not dotted config paths
// ---------------------------------------------------------------------------------------------

/** Why a Settings control is invisible to `get_config`. */
export type UnmappedStorage =
  | "ui-store" // uiStore's persisted `sparkle-ui` localStorage blob
  | "settings-store" // settingsStore's persisted `sparkle-settings` localStorage blob
  | "keybindings-store" // keybindingsStore's `sparkle-keybindings` blob
  | "keychain" // an OS keychain entry — a secret, never a config value
  | "server" // held by Sparkle's servers, not this machine
  | "command"; // no stored state at all; the control runs a backend command

export interface UnmappedSetting {
  /** The Settings pane it lives in. */
  pane: CategoryId;
  /** What the human sees. */
  control: string;
  where: UnmappedStorage;
  /** The op that drives it here, or null when this module deliberately does not expose it. */
  op: SettingsOp | null;
  /** Present iff `op` is null: why it is not exposed. */
  omittedBecause?: string;
}

/**
 * THE AUDIT. Every Settings-dialog control whose state does NOT live at a dotted config path, and
 * is therefore invisible to `get_config` / unreachable by `set_config`.
 *
 * This list is data rather than prose because it is meant to be READ BY THE CONCIERGE: the failure
 * it prevents is an agent, asked to turn off notification banners, cheerfully writing
 * `notifications.waiting = false` into config.toml — a key that does not exist, a write that
 * succeeds, and a setting that does not change. Handing the caller the real answer ("that one is in
 * the settings store; use set_notification_rule") is the only way it can tell the difference.
 *
 * Entries with `op: null` are the ones left unreachable ON PURPOSE, each with its reason. Three
 * themes run through them:
 *   • SECRETS. The cloud-agent Claude credential is written to the OS keychain and never shown
 *     again; a tool that could set it could also be talked into setting it to an attacker's key.
 *   • MONEY AND IDENTITY. Credit top-ups, the saved card, sign-in/sign-out and device pairing all
 *     move something real — a charge, a session, a credential that lets another device drive this
 *     Mac. None of them belong behind a parsed instruction.
 *   • CONSENT. The Builder Index publishes daily token totals publicly; the Sparkle-improvement
 *     setting governs use of the user's logs. A consent flag set by an agent is not consent.
 */
export const UNMAPPED_SETTINGS: readonly UnmappedSetting[] = [
  {
    pane: "notifications",
    control: "Which agent statuses raise a desktop banner",
    where: "settings-store",
    op: "set_notification_rule",
  },
  {
    pane: "appearance",
    control: "Theme (auto / light / dark)",
    where: "ui-store",
    // The WRITE already exists as the sparkle-control `set_theme` op; only the read was missing, so
    // a concierge could set the theme and never find out what it was. Exposing a second setter here
    // would put two authors on one preference for no gain.
    op: "read_appearance",
  },
  {
    pane: "appearance",
    control: "Text size (zoom)",
    where: "ui-store",
    // Same as theme: `set_zoom` exists; `read_appearance` supplies the missing read.
    op: "read_appearance",
  },
  {
    pane: "shortcuts",
    control: "Rebindable keyboard shortcuts",
    where: "keybindings-store",
    op: "set_keyboard_shortcut",
  },
  {
    pane: "advanced",
    control: "Automatically apply updates",
    where: "settings-store",
    op: "set_auto_apply_updates",
  },
  {
    pane: "advanced",
    control: "Raw config editor (Save) and Reset to defaults",
    where: "command",
    op: null,
    omittedBecause:
      "Both replace the ENTIRE global config file — every comment and every key the caller never saw. There is no per-key form that would make the blast radius visible in the request; the dotted-path ops are the safe equivalent.",
  },
  {
    pane: "cloudauth",
    control: "Claude credential for cloud agents (save / remove)",
    where: "keychain",
    op: null,
    omittedBecause:
      "An API key or OAuth token, stored encrypted and never displayed again. A tool that can write it can be talked into writing someone else's.",
  },
  {
    pane: "accounts",
    control: "Sign in / Sign out of Sparkle",
    where: "server",
    op: null,
    omittedBecause:
      "Sign-in opens an external browser flow no tool caller can complete, and sign-out drops the entitlement every paid feature reads. Both are the human's own action.",
  },
  {
    pane: "credits",
    control: "Buy credits, auto top-up, saved card",
    where: "server",
    op: null,
    omittedBecause: "Real money. A mis-parsed instruction here is a charge on the user's card.",
  },
  {
    pane: "mobile",
    control: "Pair a phone / revoke a paired device",
    where: "server",
    op: null,
    omittedBecause:
      "Minting a pair code hands another device the ability to drive this Mac; revoking one can lock the user out of their own phone. Security boundary, not a preference.",
  },
  {
    pane: "onepassword",
    control: "Install the op CLI, re-check preflight, back up .env files",
    where: "command",
    op: null,
    omittedBecause:
      "Installs a binary and copies the user's secrets into a vault. The [onepassword] flags that decide WHETHER any of it happens are ordinary config keys and already reachable.",
  },
  {
    pane: "tools",
    control: "Builder Index (publish daily token totals)",
    where: "command",
    op: null,
    omittedBecause:
      "Turning it on opens the consent modal by design — that modal is where the user reads what gets published publicly. A consent flag set by an agent is not consent. Turning it OFF is the plain `tools.builder_index` config key and is already reachable.",
  },
  {
    pane: "tools",
    control: "Straude (publish daily token totals)",
    where: "command",
    op: null,
    omittedBecause:
      "Same reasoning as the Builder Index row above, and it needs a browser sign-in the agent cannot perform. A consent flag set by an agent is not consent. Turning it OFF is the plain `tools.straude` config key and is already reachable.",
  },
  {
    pane: "ai",
    control: "Sparkle-improvement log consent",
    where: "settings-store",
    op: null,
    omittedBecause: "Governs use of the user's own logs. Same reasoning as the Builder Index consent.",
  },
  {
    pane: "accounts",
    control: "Install ID (copy)",
    where: "command",
    op: null,
    omittedBecause:
      "Not a setting — a support identifier, and copying writes to the system clipboard, clobbering whatever the human had there.",
  },
];

/** Hand the caller the audit above, so the concierge can answer "can you change that?" honestly
 *  instead of writing a config key that does not exist. Optionally narrowed to one pane. */
export function listUnmappedSettings(pane?: CategoryId): SettingsResult<UnmappedSetting[]> {
  const rows = pane ? UNMAPPED_SETTINGS.filter((s) => s.pane === pane) : UNMAPPED_SETTINGS;
  return ok("list_unmapped_settings", [...rows]);
}

// ---------------------------------------------------------------------------------------------
// GAP 2 — the drivable ones
// ---------------------------------------------------------------------------------------------

export interface AppearanceState {
  /** "auto" follows the OS appearance; "light"/"dark" force it. */
  themePref: ThemePref;
  /** Text-size multiplier PER COLUMN, each clamped by the store to [0.7, 1.8].
   *
   *  A MAP, NOT A NUMBER, because there is no single "the zoom" any more: Cmd +/- sizes whichever
   *  cockpit column has focus and each keeps its own level. Reporting one column's level as the
   *  app's would be a confident wrong answer four times out of five — and this reader exists
   *  precisely so a concierge can say what a preference currently IS. */
  zoomByColumn: Record<ZoomColumn, number>;
}

/**
 * Read the Appearance pane's two store-backed controls.
 *
 * READ-ONLY on purpose. Both already have writers on the sparkle-control surface (`set_theme`,
 * `set_zoom`) and neither had a reader — `get_config` returns the TOML file, and these two live in
 * the persisted `sparkle-ui` blob, so a concierge could set the theme and had no way to report what
 * it currently was. Adding setters here as well would put two independent authors on one preference
 * for no benefit.
 */
export function readAppearance(): SettingsResult<AppearanceState> {
  const ui = useUiStore.getState();
  return ok("read_appearance", { themePref: ui.themePref, zoomByColumn: ui.zoomByColumn });
}

export interface NotificationRule {
  status: AgentTabStatus;
  /** Does crossing INTO this status raise a Notification Center banner? */
  notify: boolean;
}

/** Every agent status and whether it currently raises a banner. Lives in settingsStore's persisted
 *  blob, not config.toml, so `get_config` cannot see any of it. */
export function listNotificationRules(): SettingsResult<NotificationRule[]> {
  const notifyStatuses = useSettingsStore.getState().notifyStatuses;
  return ok(
    "list_notification_rules",
    (Object.keys(notifyStatuses) as AgentTabStatus[]).map((status) => ({
      status,
      notify: !!notifyStatuses[status],
    })),
  );
}

/**
 * Turn the desktop banner for one agent status on or off.
 *
 * The status is validated against the store's OWN key set rather than a copy of it, so a status
 * added to `DEFAULT_NOTIFY_STATUSES` later is drivable the day it lands and a typo'd one is a
 * refusal instead of a new junk key in the persisted blob (zustand would happily keep it forever).
 *
 * The dock badge is separate and always tracks the waiting/approval count — this does not touch it.
 */
export function setNotificationRule(
  status: string,
  notify: boolean,
): SettingsResult<NotificationRule> {
  const store = useSettingsStore.getState();
  const known = Object.keys(store.notifyStatuses);
  if (!known.includes(status)) {
    return refuse(
      "set_notification_rule",
      "unknown-setting",
      `"${status}" is not an agent status. Known statuses: ${known.join(", ")}.`,
    );
  }
  const key = status as AgentTabStatus;
  store.setNotifyStatus(key, notify);
  return ok("set_notification_rule", { status: key, notify });
}

export interface ShortcutRow {
  id: ShortcutId;
  title: string;
  blurb: string;
  /** Whether a lone-modifier TAP is a valid gesture for this shortcut — see setKeyboardShortcut. */
  allowsTap: boolean;
  binding: KeyBinding;
  /** The binding as the pane renders it, e.g. "Tap ⌃ Control" or "⌘J". */
  label: string;
  /** Is it still the built-in default? */
  isDefault: boolean;
}

/** Every rebindable shortcut with its current binding. `keybindingsStore` is a localStorage blob by
 *  design ("UI preferences, not workflow config"), so none of this is in config.toml. */
export function listKeyboardShortcuts(): SettingsResult<ShortcutRow[]> {
  const bindings = useKeybindingsStore.getState().bindings;
  return ok(
    "list_keyboard_shortcuts",
    (Object.keys(SHORTCUT_LABELS) as ShortcutId[]).map((id) => {
      const binding = bindings[id] ?? SHORTCUT_DEFAULTS[id];
      return {
        id,
        title: SHORTCUT_LABELS[id].title,
        blurb: SHORTCUT_LABELS[id].blurb,
        allowsTap: SHORTCUT_LABELS[id].allowsTap,
        binding,
        label: formatBinding(binding),
        isDefault: formatBinding(binding) === formatBinding(SHORTCUT_DEFAULTS[id]),
      };
    }),
  );
}

const MODIFIER_NAMES: readonly ModifierName[] = ["Control", "Meta", "Alt", "Shift"];

/**
 * Rebind one keyboard shortcut.
 *
 * Two guards, both of which exist because the alternative is a shortcut that is SILENTLY DEAD —
 * stored, rendered in the pane, and never firing. That is worse than a refusal, because the user
 * has no way to tell it apart from a bug in the feature itself.
 *
 *  • A TAP binding on a shortcut whose `allowsTap` is false. Only the hint overlay runs a tap state
 *    machine (it needs the key RELEASE); the composer toggle is matched in a plain keydown handler,
 *    so a tap there could never match. The capture UI rejects it for exactly this reason, and this
 *    module has to as well — a tool caller does not get the capture UI.
 *  • A CHORD with no modifiers. `matchesChord` compares the key and all four modifier flags, so a
 *    bare `"j"` would fire on every literal "j" the user types anywhere in the app.
 *
 * The key is lowercased to match `matchesChord`, which compares against `e.key.toLowerCase()` — an
 * uppercase `"J"` stored verbatim would never match either.
 */
export function setKeyboardShortcut(
  id: string,
  binding: KeyBinding,
): SettingsResult<{ id: ShortcutId; binding: KeyBinding; label: string }> {
  const known = Object.keys(SHORTCUT_LABELS) as ShortcutId[];
  if (!known.includes(id as ShortcutId)) {
    return refuse(
      "set_keyboard_shortcut",
      "unknown-setting",
      `"${id}" is not a rebindable shortcut. Known shortcuts: ${known.join(", ")}.`,
    );
  }
  const shortcutId = id as ShortcutId;

  if (!binding || typeof binding !== "object") {
    return refuse(
      "set_keyboard_shortcut",
      "unsupported-binding",
      'A binding is { kind: "tap", modifier } or { kind: "chord", meta, ctrl, alt, shift, key }.',
    );
  }

  if (binding.kind === "tap") {
    if (!MODIFIER_NAMES.includes(binding.modifier)) {
      return refuse(
        "set_keyboard_shortcut",
        "unsupported-binding",
        `A tap binding's modifier must be one of ${MODIFIER_NAMES.join(", ")}.`,
      );
    }
    if (!SHORTCUT_LABELS[shortcutId].allowsTap) {
      return refuse(
        "set_keyboard_shortcut",
        "unsupported-binding",
        `"${SHORTCUT_LABELS[shortcutId].title}" is matched on key-down, so a modifier tap would never fire it. Give it a chord instead.`,
      );
    }
    useKeybindingsStore.getState().setBinding(shortcutId, binding);
    return ok("set_keyboard_shortcut", { id: shortcutId, binding, label: formatBinding(binding) });
  }

  if (binding.kind !== "chord") {
    return refuse(
      "set_keyboard_shortcut",
      "unsupported-binding",
      `A binding's kind must be "tap" or "chord".`,
    );
  }

  const key = typeof binding.key === "string" ? binding.key.trim().toLowerCase() : "";
  if (!key) {
    return refuse("set_keyboard_shortcut", "unsupported-binding", "A chord binding needs a key, e.g. \"j\".");
  }
  const normalized: KeyBinding = {
    kind: "chord",
    meta: !!binding.meta,
    ctrl: !!binding.ctrl,
    alt: !!binding.alt,
    shift: !!binding.shift,
    key,
  };
  if (!normalized.meta && !normalized.ctrl && !normalized.alt) {
    // Shift alone is not enough either — shift+j is just "J", which the user types.
    return refuse(
      "set_keyboard_shortcut",
      "unsupported-binding",
      `"${key}" with no ⌘/⌃/⌥ would fire every time the user types it. Add at least one modifier.`,
    );
  }
  useKeybindingsStore.getState().setBinding(shortcutId, normalized);
  return ok("set_keyboard_shortcut", {
    id: shortcutId,
    binding: normalized,
    label: formatBinding(normalized),
  });
}

/** Put one shortcut back to its built-in default (the pane's "Reset" link). */
export function resetKeyboardShortcut(
  id: string,
): SettingsResult<{ id: ShortcutId; binding: KeyBinding; label: string }> {
  const known = Object.keys(SHORTCUT_LABELS) as ShortcutId[];
  if (!known.includes(id as ShortcutId)) {
    return refuse(
      "reset_keyboard_shortcut",
      "unknown-setting",
      `"${id}" is not a rebindable shortcut. Known shortcuts: ${known.join(", ")}.`,
    );
  }
  const shortcutId = id as ShortcutId;
  useKeybindingsStore.getState().resetBinding(shortcutId);
  const binding = SHORTCUT_DEFAULTS[shortcutId];
  return ok("reset_keyboard_shortcut", { id: shortcutId, binding, label: formatBinding(binding) });
}

/**
 * Toggle "Automatically apply updates" (Advanced pane). settingsStore, persisted — not a config
 * key, so `get_config` never sees it.
 *
 * Routine in both directions: turning it off does not uninstall anything, it just stops the updater
 * applying a downloaded build on its own, and the user can flip it back in the same pane.
 */
export function setAutoApplyUpdates(on: boolean): SettingsResult<{ autoApplyUpdates: boolean }> {
  useSettingsStore.getState().setAutoApplyUpdates(on);
  return ok("set_auto_apply_updates", { autoApplyUpdates: on });
}

/** The Settings panes, derived from `CategoryId` so a pane added to the dialog is accepted here the
 *  day it lands. Written as a `Record<CategoryId, true>` rather than a list for the usual reason —
 *  a missing pane is a `tsc` failure, not a runtime refusal nobody sees. */
const SETTINGS_PANES: Record<CategoryId, true> = {
  ai: true,
  conciergetools: true,
  conciergevoice: true,
  tools: true,
  credits: true,
  spend: true,
  notifications: true,
  appearance: true,
  shortcuts: true,
  workers: true,
  accounts: true,
  chat: true,
  cloudauth: true,
  onepassword: true,
  chief: true,
  mobile: true,
  voice: true,
  approvals: true,
  advanced: true,
};

/**
 * Open the Settings dialog on a given pane (uiStore's `settingsRequest`, the same channel the
 * command palette and the ⋯ menu use).
 *
 * The escape hatch for everything in `UNMAPPED_SETTINGS` with `op: null`: the concierge cannot buy
 * credits or save a Claude credential, but it CAN put the user in front of the control that does,
 * which is a far better answer than "I can't help with that". `routine`, not `read-only` — this
 * lands a modal over whatever the human was looking at.
 */
export function openSettingsPane(pane: string): SettingsResult<{ pane: CategoryId }> {
  if (!Object.prototype.hasOwnProperty.call(SETTINGS_PANES, pane)) {
    return refuse(
      "open_settings_pane",
      "unknown-setting",
      `"${pane}" is not a Settings pane. Known panes: ${Object.keys(SETTINGS_PANES).join(", ")}.`,
    );
  }
  const id = pane as CategoryId;
  useUiStore.getState().openSettings(id);
  return ok("open_settings_pane", { pane: id });
}
