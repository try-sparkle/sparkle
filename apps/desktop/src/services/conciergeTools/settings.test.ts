// @vitest-environment jsdom
//
// The SETTINGS concierge tool domain. These pin the properties the domain exists to guarantee, in
// the order they matter:
//
//   1. every function returns a TYPED result — a refusal is a value, never a thrown string, and a
//      backend rejection becomes `backend-failed` rather than escaping;
//   2. the risk map is EXHAUSTIVE over the operation list (a typecheck failure AND a runtime test,
//      because a `Record` only catches the mistake at the boundary of this module);
//   3. no function reaches a native modal/dialog, and the project root is always an explicit
//      validated absolute string — never inferred from whatever project happens to be selected;
//   4. widening what agents may do without asking — and removing a global key — needs an explicit
//      `confirm: true`, and reports itself as the higher-risk operation it actually is;
//   5. the GAP-2 audit stays honest: every entry either names an op this module exports, or says
//      why it is deliberately unreachable.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  SETTINGS_OPS,
  SETTINGS_OP_RISK,
  UNMAPPED_SETTINGS,
  defaultSettingsDeps,
  listKeyboardShortcuts,
  listNotificationRules,
  listUnmappedSettings,
  openSettingsPane,
  readAppearance,
  readProjectConfig,
  resetKeyboardShortcut,
  setAutoApplyUpdates,
  setKeyboardShortcut,
  setNotificationRule,
  setProjectConfig,
  unsetGlobalConfig,
  unsetProjectConfig,
  type SettingsDeps,
} from "./settings";
import { useSettingsStore } from "../../stores/settingsStore";
import { useKeybindingsStore, SHORTCUT_DEFAULTS } from "../../stores/keybindingsStore";
import { useUiStore } from "../../stores/uiStore";
import type { SparkleConfig } from "../config";

const ROOT = "/Users/dev/code/app";

/** A config payload shaped like the real `EffectiveConfig.config`, with only the branches these
 *  tests read. Cast once here rather than at every call site. */
function mkConfig(over: Record<string, unknown> = {}): SparkleConfig {
  return {
    workers: { max_concurrent: 4 },
    approvals: { skill: null, bash: "never", edit: null, mcp: null, fetch: null, other: null },
    workflow: { require_pr: true },
    ...over,
  } as unknown as SparkleConfig;
}

let deps: SettingsDeps;
const getConfig = vi.fn(async () => ({ config: mkConfig(), warnings: [] as string[] }));
const setProject = vi.fn(async () => {});
const unsetProject = vi.fn(async () => {});
const unsetGlobal = vi.fn(async () => {});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  getConfig.mockReset();
  getConfig.mockResolvedValue({ config: mkConfig(), warnings: [] });
  setProject.mockReset();
  setProject.mockResolvedValue(undefined);
  unsetProject.mockReset();
  unsetProject.mockResolvedValue(undefined);
  unsetGlobal.mockReset();
  unsetGlobal.mockResolvedValue(undefined);
  deps = {
    getConfig,
    setProjectConfigValue: setProject,
    unsetProjectConfigValue: unsetProject,
    unsetGlobalConfigValue: unsetGlobal,
  };
  useKeybindingsStore.setState({ bindings: { ...SHORTCUT_DEFAULTS } });
  useUiStore.setState({ settingsRequest: null, themePref: "auto" });
  useUiStore.getState().resetAllZoom();
});

// ── contract 2: the risk map ────────────────────────────────────────────────────────────────────

describe("operation risk", () => {
  it("classifies every operation — exhaustively", () => {
    for (const op of SETTINGS_OPS) {
      expect(SETTINGS_OP_RISK[op], `${op} is unclassified`).toBeTruthy();
    }
    expect(Object.keys(SETTINGS_OP_RISK).sort()).toEqual([...SETTINGS_OPS].sort());
  });

  it("keeps the gated operations out of the routine classes", () => {
    expect(SETTINGS_OP_RISK.widen_approvals).toBe("permissive");
    expect(SETTINGS_OP_RISK.unset_global_config).toBe("destructive");
    // Dropping a PROJECT override falls back to a value still written down globally, so it is not
    // in the same class as dropping the global key itself.
    expect(SETTINGS_OP_RISK.unset_project_config).toBe("routine");
    expect(SETTINGS_OP_RISK.read_project_config).toBe("read-only");
    expect(SETTINGS_OP_RISK.read_appearance).toBe("read-only");
    // A modal over whatever the human was doing is not a read.
    expect(SETTINGS_OP_RISK.open_settings_pane).toBe("routine");
  });

  it("stamps the performed operation's risk onto every result", () => {
    const okRes = listUnmappedSettings();
    expect(okRes.risk).toBe(SETTINGS_OP_RISK.list_unmapped_settings);
    const refusal = openSettingsPane("nope");
    expect(refusal.ok).toBe(false);
    expect(refusal.risk).toBe(SETTINGS_OP_RISK.open_settings_pane);
  });
});

// ── contract 3: explicit paths, no native modal ─────────────────────────────────────────────────

describe("no native modal is reachable, and the project root is explicit", () => {
  // These are SOURCE assertions rather than behavioural ones, deliberately: the hazard is a FUTURE
  // operation reaching for `pickProjectFolder` (or the selected project, or a whole-file write)
  // because it feels convenient, and no runtime test can see a call that hasn't been written yet.
  //
  // Comments are stripped first — the module's header names every one of these forbidden symbols in
  // order to explain WHY it doesn't use them, and a scan that can't tell prose from code would force
  // that reasoning out of the file. `import.meta.url` is an http URL under vitest's transform, so
  // resolve from the vitest root (apps/desktop) instead.
  const code = (): string =>
    readFileSync(resolve(process.cwd(), "src/services/conciergeTools/settings.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("strips comments without stripping the code (guards the guard)", () => {
    // If this ever failed, every assertion below would pass vacuously.
    expect(code()).toMatch(/export function openSettingsPane/);
    expect(code()).not.toMatch(/DELIBERATELY ABSENT/);
  });

  // A regex lookbehind ((?<=…) / (?<!…)) is a PARSE error in the safari14 WebView this app pins
  // (esbuild does not downlevel regex features), and a parse error takes out the WHOLE module and
  // everything importing it — not just the one call. `code()` strips comments, so the header's
  // mention of the old pattern does not count. (me54 / roborev 54174.)
  it("stays lookbehind-free for the safari14 build target", () => {
    expect(code()).not.toMatch(/\(\?<[=!]/);
  });

  it("never imports the folder/file picker module", () => {
    expect(code()).not.toMatch(/from\s+"\.\.\/dialog"/);
    expect(code()).not.toMatch(/@tauri-apps\/plugin-dialog/);
  });

  // The root must come from the CALLER. Inferring it from the selected project would write an
  // auto-approve rule into whichever repo the human happened to click on mid-dispatch.
  it("never reads the project store to infer a root", () => {
    expect(code()).not.toMatch(/projectStore/);
    expect(code()).not.toMatch(/selectedProjectId/);
  });

  // Whole-file overwrites are out of reach by construction, not just by convention.
  it("never references the whole-file config commands", () => {
    expect(code()).not.toMatch(/writeConfigText/);
    expect(code()).not.toMatch(/resetConfig/);
  });

  it.each([
    ["", "blank"],
    ["   ", "whitespace"],
    ["~/code/app", "unexpanded ~"],
    ["code/app", "relative"],
  ])("refuses a %s project root (%s) without touching the backend", async (bad) => {
    const res = await setProjectConfig(bad, "workflow.require_pr", true, {}, deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("invalid-path");
    expect(setProject).not.toHaveBeenCalled();
  });

  it("normalizes a trailing separator without eating a bare root", async () => {
    await setProjectConfig(`${ROOT}//`, "workflow.require_pr", true, {}, deps);
    expect(setProject).toHaveBeenCalledWith(ROOT, "workflow.require_pr", true);
    const res = await setProjectConfig("/", "workflow.require_pr", true, {}, deps);
    expect(res.ok).toBe(true);
    expect(setProject).toHaveBeenLastCalledWith("/", "workflow.require_pr", true);
  });
});

// ── GAP 1: per-project config ───────────────────────────────────────────────────────────────────

describe("readProjectConfig", () => {
  it("reads the EFFECTIVE config for the given root, not the global layer", async () => {
    const res = await readProjectConfig(ROOT, null, deps);
    expect(res.ok).toBe(true);
    expect(getConfig).toHaveBeenCalledWith(ROOT);
    if (!res.ok) return;
    expect(res.value.path).toBeNull();
    expect(res.value.warnings).toEqual([]);
  });

  it("resolves a dotted key, including a nested one", async () => {
    getConfig.mockResolvedValue({
      config: mkConfig({ workflow: { require_pr: false, drift: { behind_nudge: 7 } } }),
      warnings: ["project layer ignored [tools]"],
    });
    const leaf = await readProjectConfig(ROOT, "workflow.drift.behind_nudge", deps);
    expect(leaf.ok).toBe(true);
    if (!leaf.ok) return;
    expect(leaf.value.value).toBe(7);
    // Warnings ride along: a project file that failed to parse reads exactly like an empty one.
    expect(leaf.value.warnings).toEqual(["project layer ignored [tools]"]);
  });

  it("distinguishes an absent key from a key set to nothing", async () => {
    // `approvals.skill` IS present in the payload — as null. That is "explicitly unset", and must
    // not be reported the same way as a key the config has never heard of.
    const nulled = await readProjectConfig(ROOT, "approvals.skill", deps);
    expect(nulled.ok).toBe(true);
    if (nulled.ok) expect(nulled.value.value).toBeNull();

    const absent = await readProjectConfig(ROOT, "approvals.nonesuch", deps);
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.reason).toBe("not-found");
  });

  it("refuses a key that runs off a leaf rather than reporting undefined as ok", async () => {
    const res = await readProjectConfig(ROOT, "workers.max_concurrent.nope", deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-found");
  });

  it("turns a backend rejection into a typed failure instead of rejecting", async () => {
    getConfig.mockRejectedValue(new Error("config.toml: expected `=` at line 4"));
    const res = await readProjectConfig(ROOT, null, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("backend-failed");
      expect(res.message).toContain("line 4");
    }
  });
});

describe("setProjectConfig", () => {
  it("writes a non-approvals key straight through as routine", async () => {
    const res = await setProjectConfig(ROOT, "workflow.require_pr", false, {}, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.op).toBe("set_project_config");
    expect(res.risk).toBe("routine");
    expect(setProject).toHaveBeenCalledWith(ROOT, "workflow.require_pr", false);
  });

  it.each([
    ["nokey", "no section"],
    ["workers.", "trailing dot"],
    [".workers", "leading dot"],
    ["workers..max", "empty segment"],
    ["work ers.max", "space"],
  ])("refuses %s as a dotted key (%s)", async (bad) => {
    const res = await setProjectConfig(ROOT, bad, 1, {}, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid-key");
    expect(setProject).not.toHaveBeenCalled();
  });

  it("refuses a non-scalar value — the TOML layer stores nothing else", async () => {
    for (const bad of [null, undefined, [1, 2], { a: 1 }, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = await setProjectConfig(ROOT, "workflow.drift.behind_nudge", bad as never, {}, deps);
      expect(res.ok, `${String(bad)} should be refused`).toBe(false);
      if (!res.ok) expect(res.reason).toBe("invalid-value");
    }
    expect(setProject).not.toHaveBeenCalled();
  });

  // The Rust merge (config.rs, the project arm) applies only [workflow], [plugins], [freshness],
  // [worktree_pool], [approvals], [done] and [delivered]. Everything else is written to the file and
  // skipped — and the write side does NOT reject it: `set_project_value` validates through
  // `parse_layer`, which "ignores unknown keys, errors on bad types/syntax" (config.rs:2056). So an
  // unhonored key is `ok` for a setting that does not move, which is exactly the GAP-2 failure this
  // module exists to prevent, turned on itself. Hence an ALLOWLIST, refused here.
  it.each(["workers.max_concurrent", "ai.auto_approve", "tools.roborev", "voice.input_device_uid", "onepassword.vault_id"])(
    "refuses to SET %s at project scope — that section is machine-wide",
    async (key) => {
      const set = await setProjectConfig(ROOT, key, true, { confirm: true }, deps);
      expect(set.ok).toBe(false);
      if (!set.ok) {
        expect(set.reason).toBe("invalid-key");
        expect(set.message).toContain("global config");
      }
      expect(setProject).not.toHaveBeenCalled();
    },
  );

  it("refuses a section the project layer has never honored, naming the ones it does", async () => {
    // Nothing comes back from Rust for this — it parses fine and is skipped in silence.
    const res = await setProjectConfig(ROOT, "brandnew.knob", 1, {}, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("invalid-key");
      expect(res.message).toContain("workflow");
      expect(res.message).toContain("approvals");
    }
    expect(setProject).not.toHaveBeenCalled();
  });

  it.each([
    "approvals.bahs",
    "approvals.commands",
    "approvals.always",
  ])("refuses %s — a misspelled approvals rule writes clean and does nothing", async (key) => {
    // The dangerous silent no-op: a caller that believes it pinned a category to "never" for this
    // repo is still running under the permissive GLOBAL default, and nothing in an `ok` says so.
    const res = await setProjectConfig(ROOT, key, "never", {}, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("invalid-key");
      expect(res.message).toContain("approvals.bash");
    }
    expect(setProject).not.toHaveBeenCalled();
  });

  it("KNOWN GAP: a typo inside another honored section is not caught", async () => {
    // Pinned so the limitation is visible rather than accidental. Catching this would mean keeping
    // a second copy of the whole config schema here (it lives in Rust) or round-tripping getConfig
    // after every write. `[approvals]` is carved out above because there the silent no-op is a
    // SAFETY belief, not a preference. If this ever starts failing, the gap has been closed —
    // delete the test rather than restoring the behaviour.
    const res = await setProjectConfig(ROOT, "workflow.requre_pr", true, {}, deps);
    expect(res.ok).toBe(true);
    expect(setProject).toHaveBeenCalledWith(ROOT, "workflow.requre_pr", true);
  });

  it("rejects reserved JavaScript property names in a key, on every arm", async () => {
    // `keyProblem`'s regex admits these, and a dotted walk over a plain object resolves them off
    // Object.prototype: readProjectConfig would come back `ok` with a FUNCTION as the config value,
    // or `{}` for `workflow.__proto__` — a key the config never heard of, reported as set.
    for (const key of ["__proto__.constructor", "workflow.__proto__", "constructor.foo", "workflow.prototype"]) {
      const set = await setProjectConfig(ROOT, key, 1, {}, deps);
      expect(set.ok, `set ${key}`).toBe(false);
      if (!set.ok) {
        expect(set.reason).toBe("invalid-key");
        expect(set.message).not.toContain("native code");
        expect(set.message).not.toContain("[object Object]");
      }
      const unset = await unsetProjectConfig(ROOT, key, { confirm: true }, deps);
      expect(unset.ok, `unset ${key}`).toBe(false);
      const read = await readProjectConfig(ROOT, key, deps);
      expect(read.ok, `read ${key}`).toBe(false);
      if (!read.ok) expect(read.reason).toBe("invalid-key");
      const globalUnset = await unsetGlobalConfig(key, { confirm: true }, deps);
      expect(globalUnset.ok, `global unset ${key}`).toBe(false);
    }
    expect(setProject).not.toHaveBeenCalled();
    expect(unsetProject).not.toHaveBeenCalled();
    expect(unsetGlobal).not.toHaveBeenCalled();
  });

  it("looks up the refusal reason by own property, not off the prototype", async () => {
    // `toString` is an inherited member that is NOT on the reserved-segment list, so it reaches the
    // reason table. A bare index there would splice a function body into the sentence.
    const res = await setProjectConfig(ROOT, "toString.x", 1, {}, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("invalid-key");
      expect(res.message).not.toContain("native code");
      expect(res.message).toContain("workflow"); // the honored-sections list, not a function body
    }
  });

  it("walks own properties only, even if a key slipped past validation", async () => {
    // Defense in depth: valueAtPath carries its own guard rather than trusting a check two
    // functions away. `toString` is a real inherited member and is not on the reserved list.
    const res = await readProjectConfig(ROOT, "workflow.toString", deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-found");
  });

  it.each(["workflow.require_pr", "plugins.superpowers", "freshness.require_fresh_branch", "done.description"])(
    "still forwards %s — the layer honors that section",
    async (key) => {
      const res = await setProjectConfig(ROOT, key, true, {}, deps);
      expect(res.ok).toBe(true);
      expect(setProject).toHaveBeenLastCalledWith(ROOT, key, true);
    },
  );

  // The UNSET arm deliberately does NOT apply the allowlist. A machine-wide key can already be in a
  // project file — hand-written, left by an older build, or written by this tool before the
  // allowlist existed — and refusing to delete it would strand it there with no way out.
  it.each(["workers.max_concurrent", "brandnew.knob"])(
    "still lets you REMOVE %s from a project file — deleting is cleanup",
    async (key) => {
      const res = await unsetProjectConfig(ROOT, key, {}, deps);
      expect(res.ok).toBe(true);
      expect(unsetProject).toHaveBeenCalledWith(ROOT, key);
    },
  );

  it("turns a backend rejection into a typed failure", async () => {
    // The rejection Rust actually produces: `set_project_value` renders the edited document and
    // re-parses it, so a TYPE mismatch is caught (a string into a bool). An unknown KEY is not —
    // `parse_layer` ignores those, which is why the allowlist above exists instead.
    setProject.mockRejectedValue(
      "rejected: that change would make .sparkle/config.toml invalid: invalid type: string, expected a boolean",
    );
    const res = await setProjectConfig(ROOT, "workflow.require_pr", "yes", {}, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("backend-failed");
      expect(res.message).toContain("expected a boolean");
    }
  });
});

// ── contract 4: widening needs confirm ──────────────────────────────────────────────────────────

describe("widening auto-approve is gated", () => {
  it("refuses a permissive category rule without confirm, and reports the widen op", async () => {
    const res = await setProjectConfig(ROOT, "approvals.bash", "always", {}, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.op).toBe("widen_approvals");
      expect(res.risk).toBe("permissive");
      expect(res.reason).toBe("confirmation-required");
      expect(res.message).toContain("confirm: true");
    }
    expect(setProject).not.toHaveBeenCalled();
  });

  it("writes it with confirm, still reporting the higher-risk op", async () => {
    const res = await setProjectConfig(ROOT, "approvals.edit", "always", { confirm: true }, deps);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.op).toBe("widen_approvals");
      expect(res.risk).toBe("permissive");
    }
    expect(setProject).toHaveBeenCalledWith(ROOT, "approvals.edit", "always");
  });

  it("covers EVERY approval category, not a hand-copied subset", async () => {
    for (const cat of ["skill", "bash", "edit", "mcp", "fetch", "other"]) {
      const res = await setProjectConfig(ROOT, `approvals.${cat}`, "always", {}, deps);
      expect(res.ok, `approvals.${cat} should be gated`).toBe(false);
      if (!res.ok) expect(res.op).toBe("widen_approvals");
    }
  });

  it.each(["summary", "full"])("gates the auto-resuming resume rule %s", async (rule) => {
    const res = await setProjectConfig(ROOT, "approvals.resume", rule, {}, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.op).toBe("widen_approvals");
  });

  it("does NOT gate the restrictive directions — narrowing needs no ceremony", async () => {
    const never = await setProjectConfig(ROOT, "approvals.bash", "never", {}, deps);
    expect(never.ok).toBe(true);
    if (never.ok) expect(never.op).toBe("set_project_config");

    const ask = await setProjectConfig(ROOT, "approvals.resume", "ask", {}, deps);
    expect(ask.ok).toBe(true);
    if (ask.ok) expect(ask.op).toBe("set_project_config");
  });

  it("treats REMOVING a project approvals override as a widening too", async () => {
    // The subtle case: a project sitting on `bash = "never"` is relying on the override. Dropping it
    // hands the repo whatever the global rule says, which may be "always".
    const res = await unsetProjectConfig(ROOT, "approvals.bash", {}, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.op).toBe("widen_approvals");
      expect(res.reason).toBe("confirmation-required");
    }
    expect(unsetProject).not.toHaveBeenCalled();

    const confirmed = await unsetProjectConfig(ROOT, "approvals.bash", { confirm: true }, deps);
    expect(confirmed.ok).toBe(true);
    expect(unsetProject).toHaveBeenCalledWith(ROOT, "approvals.bash");
  });

  it("leaves a non-approvals project unset routine and ungated", async () => {
    const res = await unsetProjectConfig(ROOT, "workflow.require_pr", {}, deps);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.op).toBe("unset_project_config");
      expect(res.risk).toBe("routine");
    }
    expect(unsetProject).toHaveBeenCalledWith(ROOT, "workflow.require_pr");
  });
});

describe("unsetGlobalConfig", () => {
  // The trap this pins: Sparkle's shipped defaults are PERMISSIVE. `ApprovalsConfig::default()` in
  // src-tauri/src/config.rs sets all six categories to "always" (bash included) and
  // `[ai].auto_approve` defaults true — so removing a global `approvals.bash = "never"`, the very
  // key a user writes to stop unattended command execution, hands it back machine-wide. "Removing a
  // key" is not automatically the safe direction here.
  it.each([
    "approvals.skill",
    "approvals.bash",
    "approvals.edit",
    "approvals.mcp",
    "approvals.fetch",
    "approvals.other",
    "ai.auto_approve",
  ])("classifies unsetting %s as a widening, not a plain deletion", async (key) => {
    const res = await unsetGlobalConfig(key, { confirm: false }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.op).toBe("widen_approvals");
      expect(res.risk).toBe("permissive");
      expect(res.message).toContain("PERMISSIVE");
    }
    expect(unsetGlobal).not.toHaveBeenCalled();

    const confirmed = await unsetGlobalConfig(key, { confirm: true }, deps);
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) expect(confirmed.op).toBe("widen_approvals");
    expect(unsetGlobal).toHaveBeenCalledWith(key);
  });

  it("does NOT call approvals.resume a widening — it alone defaults to \"ask\"", async () => {
    const res = await unsetGlobalConfig("approvals.resume", { confirm: true }, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.op).toBe("unset_global_config");
  });

  it("refuses without confirm — the value is gone once the key is", async () => {
    const res = await unsetGlobalConfig("workers.max_concurrent", { confirm: false }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("confirmation-required");
    expect(unsetGlobal).not.toHaveBeenCalled();
  });

  it("removes the key with confirm — the only way back to AUTO concurrency", async () => {
    const res = await unsetGlobalConfig("workers.max_concurrent", { confirm: true }, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.risk).toBe("destructive");
    expect(unsetGlobal).toHaveBeenCalledWith("workers.max_concurrent");
  });

  it("validates the key before confirming anything", async () => {
    const res = await unsetGlobalConfig("workers", { confirm: true }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid-key");
    expect(unsetGlobal).not.toHaveBeenCalled();
  });

  it("turns a backend rejection into a typed failure", async () => {
    unsetGlobal.mockRejectedValue(new Error("permission denied"));
    const res = await unsetGlobalConfig("workers.max_concurrent", { confirm: true }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("backend-failed");
  });
});

describe("defaultSettingsDeps", () => {
  it("routes each dep at the config command it names", async () => {
    const real = defaultSettingsDeps();
    invoke.mockResolvedValue({ config: mkConfig(), warnings: [] });
    await real.getConfig(ROOT);
    await real.setProjectConfigValue(ROOT, "workflow.require_pr", true);
    await real.unsetProjectConfigValue(ROOT, "workflow.require_pr");
    await real.unsetGlobalConfigValue("workflow.require_pr");
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      "get_config",
      "set_project_config_value",
      "unset_project_config_value",
      "unset_config_value",
    ]);
    // And never a whole-file overwrite.
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain("write_config_text");
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain("reset_config");
  });
});

// ── GAP 2: the audit ────────────────────────────────────────────────────────────────────────────

describe("the unmapped-settings audit", () => {
  it("either names a real op or says why the control is unreachable", () => {
    for (const row of UNMAPPED_SETTINGS) {
      if (row.op === null) {
        expect(row.omittedBecause, `${row.control} is unreachable with no reason`).toBeTruthy();
      } else {
        expect(SETTINGS_OPS, `${row.control} names an op this module doesn't export`).toContain(row.op);
        expect(row.omittedBecause).toBeUndefined();
      }
    }
  });

  it("keeps the secret / money / consent controls out of reach", () => {
    const unreachable = UNMAPPED_SETTINGS.filter((r) => r.op === null).map((r) => r.pane);
    for (const pane of ["cloudauth", "credits", "mobile", "accounts", "advanced"]) {
      expect(unreachable, `${pane} should have at least one deliberately unreachable control`).toContain(pane);
    }
  });

  it("narrows to one pane on request", () => {
    const res = listUnmappedSettings("shortcuts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.length).toBeGreaterThan(0);
    expect(res.value.every((r) => r.pane === "shortcuts")).toBe(true);
  });

  it("hands back a copy — a caller can't mutate the audit", () => {
    const res = listUnmappedSettings();
    if (!res.ok) throw new Error("expected ok");
    res.value.length = 0;
    expect(UNMAPPED_SETTINGS.length).toBeGreaterThan(0);
  });
});

// ── GAP 2: the drivable ones ────────────────────────────────────────────────────────────────────

describe("appearance", () => {
  it("reads the two store-backed controls get_config cannot see", () => {
    // Through the ACTION, not a hand-built partial object. `setState` merges shallowly, so writing
    // `{ concierge: 1.2 }` would replace the whole map and leave every other column `undefined` —
    // which is the exact `NaN` hazard `repairZoomByColumn` exists to prevent, smuggled in by the
    // test's own fixture. Setting one column through the store keeps the record complete.
    useUiStore.setState({ themePref: "dark" });
    useUiStore.getState().resetAllZoom();
    useUiStore.getState().setColumnZoom("concierge", 1.2);
    const res = readAppearance();
    expect(res.ok).toBe(true);
    if (res.ok) {
      // PER COLUMN — reporting one column's level as "the" zoom would be a confident wrong answer
      // four times out of five, and this reader exists precisely to say what a preference IS.
      expect(res.value.themePref).toBe("dark");
      expect(res.value.zoomByColumn.concierge).toBe(1.2);
      expect(res.value.zoomByColumn["build-left"]).toBe(1);
    }
  });
});

describe("notification rules", () => {
  it("lists every status with its current banner setting", () => {
    const res = listNotificationRules();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const waiting = res.value.find((r) => r.status === "waiting");
    expect(waiting).toBeDefined();
    expect(typeof waiting?.notify).toBe("boolean");
  });

  it("flips one status and leaves the rest alone", () => {
    const before = { ...useSettingsStore.getState().notifyStatuses };
    const res = setNotificationRule("waiting", !before.waiting);
    expect(res.ok).toBe(true);
    const after = useSettingsStore.getState().notifyStatuses;
    expect(after.waiting).toBe(!before.waiting);
    expect(after.errored).toBe(before.errored);
    expect(after.done).toBe(before.done);
  });

  it("refuses an unknown status instead of adding junk to the persisted blob", () => {
    const before = Object.keys(useSettingsStore.getState().notifyStatuses).sort();
    const res = setNotificationRule("nonesuch", true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unknown-setting");
    expect(Object.keys(useSettingsStore.getState().notifyStatuses).sort()).toEqual(before);
  });
});

describe("keyboard shortcuts", () => {
  it("lists each shortcut with a rendered label and whether it is still the default", () => {
    const res = listKeyboardShortcuts();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const composer = res.value.find((r) => r.id === "toggleComposer");
    expect(composer?.label).toBe("⌘J");
    expect(composer?.isDefault).toBe(true);
    expect(composer?.allowsTap).toBe(false);
  });

  it("rebinds a chord, lowercasing the key so matchesChord can ever match it", () => {
    const res = setKeyboardShortcut("toggleComposer", {
      kind: "chord",
      meta: true,
      ctrl: false,
      alt: true,
      shift: false,
      key: "K",
    });
    expect(res.ok).toBe(true);
    const stored = useKeybindingsStore.getState().bindings.toggleComposer;
    expect(stored).toEqual({ kind: "chord", meta: true, ctrl: false, alt: true, shift: false, key: "k" });
  });

  it("refuses a tap on a shortcut matched in keydown — it would be silently dead", () => {
    const res = setKeyboardShortcut("toggleComposer", { kind: "tap", modifier: "Control" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unsupported-binding");
    expect(useKeybindingsStore.getState().bindings.toggleComposer).toEqual(SHORTCUT_DEFAULTS.toggleComposer);
  });

  it("accepts a tap on the shortcut that runs a tap state machine", () => {
    const res = setKeyboardShortcut("toggleHints", { kind: "tap", modifier: "Alt" });
    expect(res.ok).toBe(true);
    expect(useKeybindingsStore.getState().bindings.toggleHints).toEqual({ kind: "tap", modifier: "Alt" });
  });

  it("refuses a chord with no ⌘/⌃/⌥ — it would fire on ordinary typing", () => {
    for (const mods of [
      { meta: false, ctrl: false, alt: false, shift: false },
      { meta: false, ctrl: false, alt: false, shift: true },
    ]) {
      const res = setKeyboardShortcut("toggleComposer", { kind: "chord", key: "j", ...mods });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("unsupported-binding");
    }
    expect(useKeybindingsStore.getState().bindings.toggleComposer).toEqual(SHORTCUT_DEFAULTS.toggleComposer);
  });

  it.each([
    [{ kind: "chord", meta: true, ctrl: false, alt: false, shift: false, key: "  " }, "blank key"],
    [{ kind: "tap", modifier: "Escape" }, "not a modifier"],
    [{ kind: "wiggle" }, "unknown kind"],
  ])("refuses a malformed binding (%#: %s)", (binding, _why) => {
    const res = setKeyboardShortcut("toggleHints", binding as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unsupported-binding");
  });

  it("refuses an unknown shortcut id", () => {
    const res = setKeyboardShortcut("nonesuch", { kind: "tap", modifier: "Control" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unknown-setting");
    expect(resetKeyboardShortcut("nonesuch").ok).toBe(false);
  });

  it("resets one shortcut back to its built-in default", () => {
    setKeyboardShortcut("toggleHints", { kind: "tap", modifier: "Alt" });
    const res = resetKeyboardShortcut("toggleHints");
    expect(res.ok).toBe(true);
    expect(useKeybindingsStore.getState().bindings.toggleHints).toEqual(SHORTCUT_DEFAULTS.toggleHints);
  });
});

describe("auto-apply updates", () => {
  it("toggles the settings-store flag get_config cannot see", () => {
    setAutoApplyUpdates(false);
    expect(useSettingsStore.getState().autoApplyUpdates).toBe(false);
    const res = setAutoApplyUpdates(true);
    expect(res.ok).toBe(true);
    expect(useSettingsStore.getState().autoApplyUpdates).toBe(true);
  });
});

describe("openSettingsPane", () => {
  it("puts the user in front of a control the concierge cannot drive itself", () => {
    const res = openSettingsPane("credits");
    expect(res.ok).toBe(true);
    expect(useUiStore.getState().settingsRequest).toBe("credits");
  });

  it("accepts every pane the dialog actually has", () => {
    for (const pane of UNMAPPED_SETTINGS.map((r) => r.pane)) {
      expect(openSettingsPane(pane).ok, `${pane} should be a known pane`).toBe(true);
    }
  });

  it("refuses an unknown pane rather than opening the dialog on nothing", () => {
    const res = openSettingsPane("kitchen-sink");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unknown-setting");
    expect(useUiStore.getState().settingsRequest).toBeNull();
  });

  it("is not fooled by an inherited Object.prototype key", () => {
    // `"constructor" in SETTINGS_PANES` is true for a plain object; hasOwnProperty is not.
    const res = openSettingsPane("constructor");
    expect(res.ok).toBe(false);
    expect(useUiStore.getState().settingsRequest).toBeNull();
  });
});
