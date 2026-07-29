import { useEffect, type CSSProperties, type ComponentType, type ReactNode } from "react";
import {
  FiMic,
  FiShare2,
  FiGithub,
  FiBarChart2,
  FiTerminal,
  FiShield,
  FiCheckCircle,
  FiBookOpen,
  FiLayout,
  FiExternalLink,
  FiTrendingUp,
  FiLock,
  FiGitBranch,
  FiCheckSquare,
} from "react-icons/fi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { useSettingsStore, aiFeatureMode } from "../stores/settingsStore";
import {
  setAiFeature,
  setToolEnabled,
  setPluginEnabled,
  setRoborevEnabled,
  refreshPluginInstallState,
  setBuilderIndexEnabled,
} from "../services/configActions";
import { BUILDER_INDEX_URL } from "../services/builderIndex";
import { matchesSearch } from "../engine/settingsSearch";
import { FONT_UI, PILL } from "../theme/scale";
import { CHIP, SECTION_LABEL } from "./labelTreatment";

// The "Tools" pane of the ⋯ settings dialog. Two groups:
//   • "Your tools"        — real on/off rows (config-backed). Off means the tool is used NOWHERE in
//                           Sparkle. Chief/Deepgram reuse the [ai] flags (brainstorm/voice_dictation)
//                           and carry an "AI" badge; Superpowers/Frontend design are [plugins]
//                           flags (Claude Code plugins pre-enabled for every agent); the rest are
//                           [tools] flags.
//   • "Built into Sparkle" — showcase rows (icon + name + description + Learn-more + a badge, NO
//                           switch): the always-on capabilities that come with Sparkle.
// AI gating: when the AI master is Off (aiFeatureMode === "off"), the two AI rows are disabled +
// shown off with a hint — turning AI back on re-enables them (they ARE [ai] flags).
//
// The optional `query` prop mirrors the ⋯-dialog rail search: when set, rows whose name/description
// don't match are hidden (a group with no surviving rows disappears entirely).

/** ONE table per row: the name it renders, the description it renders, and its extra search terms.
 *
 *  A row's searchable surface and the rail's advertised terms are BOTH derived from this literal,
 *  which is the only way the rail↔row contract holds by construction instead of by vigilance:
 *    • the rail advertises exactly what the rows answer to, so a term the rail offers can never
 *      fail to match a row — the "No tools match" dead end;
 *    • and a row can't carry a term the rail withholds, which is the worse dead end: the query
 *      matches no CATEGORY, the rail renders "No settings match", and the pane is never reached.
 *
 *  The previous shape kept names in a second hand-maintained array and left `desc` out of the
 *  derivation entirely. That was not a hypothetical gap — `repositories`, `masked`, `anonymous`,
 *  `typechecks`, `worktrees` and `on-device` all appear in a row's description, matched the row,
 *  and matched no category, so each was a live dead end while a comment above claimed otherwise.
 *
 *  `as const satisfies` keeps every lookup compiler-checked: a plain Record<string, …> annotation
 *  makes them `string | undefined` under noUncheckedIndexedAccess, which assigns cleanly to the
 *  optional `keywords?` — so a typo would compile silently and put the dead end back. */
export const TOOL_META = {
  deepgram: {
    name: "Deepgram voice",
    desc: "Cloud dictation (Nova). Off falls back to on-device speech.",
    keywords: "deepgram voice dictation speech nova microphone",
  },
  guardrails: {
    name: "Guardrails",
    desc: "Opinionated quality workflow for the code Sparkle writes: test-first, run the tests and typechecks before committing, and never call a red build done. Off removes it.",
    keywords: "guardrails tests typecheck quality",
  },
  roborev: {
    name: "Roborev",
    desc: "Per-commit AI code review of your BUILD agents' commits, using your Claude login.",
    keywords: "roborev review code review findings",
  },
  onepassword: {
    name: "1Password env backup",
    desc: "Back your .env files up to a 1Password vault, and restore them into fresh agent worktrees.",
    keywords: "onepassword 1password op cli secrets dotenv env vault backup restore seed worktree",
  },
  beads: {
    name: "Beads",
    desc: "The in-repo work graph behind the Plan board.",
    keywords: "beads bd plan board work graph issues",
  },
  github: {
    name: "GitHub import",
    desc: "Pull a project straight from your GitHub repositories.",
    keywords: "github import clone repository",
  },
  analytics: {
    name: "Usage analytics",
    desc: "Anonymous usage + masked session replay that help improve Sparkle. Off sends nothing.",
    keywords: "usage analytics posthog privacy telemetry session replay",
  },
  "claude-code": {
    name: "Claude Code",
    desc: "The agent engine behind every Sparkle agent.",
    keywords: "claude code agent engine cli",
  },
  builderIndex: {
    name: "Builder Index",
    desc: "Publish your daily token totals to the public tokenmaxxing leaderboard. Aggregates only, never your code or prompts.",
    keywords: "builder index tokenmaxxing leaderboard publish daily tokens totals rank public",
  },
  superpowers: {
    name: "Superpowers",
    desc: "The most-used agent methodology plugin: plan → TDD → review.",
    keywords: "superpowers skills skill library plugin methodology plan tdd debug ship review",
  },
  frontendDesign: {
    name: "Frontend design",
    desc: "Anthropic's official UI-quality skill.",
    keywords: "frontend design ui quality plugin skill anthropic official marketplace",
  },
  sparkleGuardrails: {
    name: "Guardrails skill",
    desc: "The same discipline as Guardrails above, packaged as an installable skill you can use in plain Claude Code. Off by default — Guardrails already applies it to Sparkle's agents.",
    keywords:
      "guardrails quality regression tests typecheck lint build verification sparkle marketplace plugin",
  },
  sparkleFreshness: {
    name: "Branch freshness",
    desc: "Warn at session start when your branch has fallen far behind the default branch, so agents rebase instead of debugging failures that aren't theirs.",
    keywords:
      "freshness stale branch rebase behind main default git session start sparkle marketplace plugin",
  },
  sparkleMutationCheck: {
    name: "Mutation check",
    desc: "Prove a test can actually fail. Mutates the source under test and flags any test that stays green — vacuous or stale.",
    keywords:
      "mutation check test quality vacuous stale prove fail assertion sparkle marketplace plugin",
  },
} as const satisfies Record<string, { name: string; desc: string; keywords: string }>;

/** One searchable string PER ROW — the same `name + desc + keywords` haystack the pane matches a
 *  row against, so the rail can ask the pane's exact question instead of an approximation of it.
 *
 *  Per row, not one blob: a blob accepts a query whose terms live in DIFFERENT rows ("deepgram
 *  beads"), which surfaces the category and then matches no row — the "No tools match" dead end.
 *  The rail requires all terms inside one entry, which is what the pane will do too. */
export const TOOLS_SEARCH_ENTRIES = Object.values(TOOL_META).map(
  (t) => `${t.name} ${t.desc} ${t.keywords}`,
);

/** Every word any Tools row is searchable by, as one string. Kept for the places that just need the
 *  vocabulary (tests asserting nothing is unadvertised); MATCHING goes through TOOLS_SEARCH_ENTRIES,
 *  because this form cannot tell "one row has both terms" from "two rows have one each". */
export const TOOLS_CATEGORY_KEYWORDS = TOOLS_SEARCH_ENTRIES.join(" ");

const AI_HINT = "Turn on AI features to use this tool.";

/** Shown when 1Password backup is switched on but no vault has been chosen — the state in which
 *  the toggle looks active while nothing is actually being backed up. */
const NO_VAULT_HINT = "Open Settings → 1Password to choose a vault and start backing up your .env files.";

type BadgeKind = "ai" | "core" | "builtin";

interface Badge {
  kind: BadgeKind;
  text: string;
}

/** A themed pill badge. "ai" is the accent-tinted AI marker; "core"/"builtin" mark showcase tools. */
function BadgePill({ kind, children }: { kind: BadgeKind; children: string }) {
  const palette: Record<BadgeKind, { bg: string; fg: string; border: string }> = {
    ai: { bg: "rgba(52,224,240,0.14)", fg: C.accentInk, border: "rgba(52,224,240,0.4)" },
    core: { bg: "rgba(47,107,255,0.16)", fg: C.cream, border: "rgba(47,107,255,0.5)" },
    builtin: { bg: "transparent", fg: C.muted, border: C.muted },
  };
  const p = palette[kind];
  return (
    <span
      style={{
        ...CHIP,
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 7px",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        background: p.bg,
        color: p.fg,
        border: `1px solid ${p.border}`,
      }}
    >
      {children}
    </span>
  );
}

/** A small on/off switch (role="switch") consistent with the app's teal/muted palette. */
function Switch({
  checked,
  disabled,
  onToggle,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      style={{
        position: "relative",
        flex: "0 0 auto",
        width: 34,
        height: 20,
        // A switch TRACK is the capsule shape itself, the way its knob is a circle — `PILL` is what
        // scale.ts keeps for exactly these, so this is naming the shape, not reaching past the scale.
        borderRadius: PILL,
        border: "none",
        padding: 0,
        background: checked ? C.teal : C.muted,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 120ms",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 16 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: ON_BRAND_FILL,
          transition: "left 120ms",
        }}
      />
    </button>
  );
}

/** Open a provider URL in the OS browser. Best-effort; a failure just logs (never throws upward). */
function learnMore(url: string) {
  void openUrl(url).catch((e) => console.warn("tools: open url failed", url, e));
}

/** Shared row chrome: icon, name + badge, description, Learn-more link, optional hint. The
 *  right-hand `control` is a switch (toggleable tools) or a badge (showcase tools). */
function ToolRow({
  Icon,
  name,
  desc,
  url,
  badge,
  control,
  hint,
  onHintClick,
}: {
  Icon: ComponentType<{ size?: number }>;
  name: string;
  desc: string;
  url?: string;
  badge?: Badge;
  control: ReactNode;
  hint?: string;
  /** When set, the hint renders as a button instead of static text (see the Builder Index row). */
  onHintClick?: () => void;
}) {
  return (
    // The testid is how a test counts RENDERED rows without deriving the list from TOOL_META.
    // Showcase rows carry no switch and no other handle, so without it an added showcase row with
    // inline strings is invisible to the "nothing renders that isn't in the table" check.
    <div style={rowStyle} data-testid="tool-row">
      <div style={{ flex: "0 0 auto", marginTop: 2, color: C.muted }}>
        <Icon size={18} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: C.cream, fontWeight: FONT_WEIGHT.semibold, fontSize: 13 }}>
            {name}
          </span>
          {badge && <BadgePill kind={badge.kind}>{badge.text}</BadgePill>}
        </div>
        <div style={descStyle}>{desc}</div>
        {url && (
          // aria-label carries the tool name so multiple "Learn more" links are distinguishable to
          // screen readers (and to tests) rather than all reading as a bare "Learn more".
          <button
            type="button"
            aria-label={`Learn more about ${name}`}
            style={learnMoreStyle}
            onClick={() => learnMore(url)}
          >
            Learn more
            <FiExternalLink size={11} />
          </button>
        )}
        {hint &&
          (onHintClick ? (
            <button type="button" onClick={onHintClick} style={hintButtonStyle}>
              {hint}
            </button>
          ) : (
            <div style={hintStyle}>{hint}</div>
          ))}
      </div>
      <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", paddingTop: 2 }}>
        {control}
      </div>
    </div>
  );
}

/** A config-backed on/off tool. `ai` rows reuse the [ai] flags and lock when the AI master is Off. */
interface ToggleTool {
  key: string;
  Icon: ComponentType<{ size?: number }>;
  name: string;
  desc: string;
  /** Optional "Learn more" target. Omitted for first-party capabilities with no external page. */
  url?: string;
  ai?: boolean;
  /** Row-specific note under the description (e.g. roborev's auth self-test result). Takes
   *  precedence over the generic AI-master hint. */
  hint?: string;
  /** Makes the hint a button (e.g. Builder Index's "Manage…" re-entry into its settings dialog). */
  onHintClick?: () => void;
  /** Extra search terms, matched alongside name + desc. The rail lists a category's keywords, so
   *  without the same terms here a query like "dotenv" surfaces Tools and then renders "No tools
   *  match" — a dead end worse than not matching at all. */
  keywords?: string;
  checked: boolean;
  onToggle: () => void;
}

/** A showcase (built-in) tool: info + badge, never a switch. */
interface ShowcaseTool {
  Icon: ComponentType<{ size?: number }>;
  name: string;
  desc: string;
  url?: string;
  /** Extra search terms, matched alongside name + desc — same contract as ToggleTool.keywords. */
  keywords?: string;
  badge: Badge;
}

/** The GitHub repo backing Anthropic's official plugin marketplace. Must stay identical to
 *  `config::OFFICIAL_MARKETPLACE_REPO` in src-tauri/src/config.rs, which is what the installer
 *  actually runs `claude plugin marketplace add` against — a Learn-more link pointing at a
 *  different repo than the one we install from is how the previous `claude-plugins-public` 404
 *  happened. A Rust test (`hooks::tests::the_frontend_learn_more_url_matches_the_repo_we_install_from`)
 *  fails if these two drift apart. */
const OFFICIAL_MARKETPLACE_REPO = "anthropics/claude-plugins-official";
/** Sparkle's own public marketplace — the source of the sparkle* plugin rows below. Kept beside the
 *  official-marketplace constant so a "Learn more" link can never point at a repo we don't install
 *  from; `every_shipped_plugin_carries_a_source_and_only_foreign_ones_are_declared` pins the Rust
 *  half of that pair. */
const SPARKLE_MARKETPLACE_URL = "https://github.com/try-sparkle/marketplace";

const FRONTEND_DESIGN_URL = `https://github.com/${OFFICIAL_MARKETPLACE_REPO}/tree/main/plugins/frontend-design`;

/** Both plugin rows carry this. Sparkle writes `enabledPlugins` into an agent worktree's
 *  settings.local.json at prepare time and never removes an entry (insert-if-absent, so a plugin
 *  the user enabled or disabled by hand always wins). That means switching a plugin OFF here does
 *  NOT retract it from worktrees that already have it — without saying so, the toggle looks broken
 *  for every agent already on screen. */
const PLUGIN_SCOPE_HINT = "Applies to agents created from now on.";

/** What a plugin row's hint line should say, given the installer's current state for it. The
 *  install is the half of a toggle-on the user can't see — it shells out to `claude plugin install`
 *  and can take a while or fail (offline, no `claude`, marketplace outage) — so the row reports it
 *  rather than leaving a switch that says ON with the plugin absent. Falls back to the scope note
 *  when there's nothing in flight. */
function pluginHint(state: string | undefined): string {
  if (state === "installing") return "Installing…";
  return state ?? PLUGIN_SCOPE_HINT;
}

// Superpowers used to live here as a showcase row. It is now a real, config-backed toggle
// ([plugins].superpowers) below, so listing it in both places would show the same tool twice with
// only one of them actually doing anything.
const SHOWCASE: ShowcaseTool[] = [
  {
    // Spread, not field-by-field: a row that copies a name/desc out of TOOL_META can still be
    // edited in place later, and an inlined desc is a term the rail never advertises — the dead end
    // this table exists to prevent.
    //
    // The spread goes FIRST in every row literal, so an explicit field always wins and the
    // precedence is the same everywhere. (TS does not excess-property-check spreads, so a field
    // added to TOOL_META later would otherwise silently override whichever rows happened to list
    // theirs above it.) What this does NOT catch is a brand-new row written with inline strings —
    // `name: string` still accepts any literal — which is what the row-set test in ToolsPane.test
    // pins from the DOM side.
    ...TOOL_META["claude-code"],
    Icon: FiTerminal,
    url: "https://claude.com/claude-code",
    badge: { kind: "core", text: "Core" },
  },
];

export function ToolsPane({ query = "" }: { query?: string }) {
  // Hydrate the plugin rows from the LAST install pass — usually the one that ran at startup.
  // Without this, a plugin that failed to install at launch shows a switch that reads ON with no
  // hint, and the user only learns about it if they happen to toggle the row. Cheap: a cached read
  // in Rust, no filesystem work.
  useEffect(() => {
    void refreshPluginInstallState();
  }, []);

  // AI flags: Deepgram = voiceDictation. The AI master derives from all of them.
  const aiAutoRename = useSettingsStore((s) => s.aiAutoRename);
  const cloudDictation = useSettingsStore((s) => s.cloudDictation);
  const aiComposer = useSettingsStore((s) => s.aiComposer);
  const aiSuggestedActions = useSettingsStore((s) => s.aiSuggestedActions);
  const aiAutoApprove = useSettingsStore((s) => s.aiAutoApprove);
  const aiConcierge = useSettingsStore((s) => s.aiConcierge);
  // [tools] flags.
  const analyticsEnabled = useSettingsStore((s) => s.analyticsEnabled);
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);
  const githubEnabled = useSettingsStore((s) => s.githubEnabled);
  const guardrailsEnabled = useSettingsStore((s) => s.guardrailsEnabled);
  const roborevEnabled = useSettingsStore((s) => s.roborevEnabled);
  const roborevAuthWarning = useSettingsStore((s) => s.roborevAuthWarning);
  const builderIndexEnabled = useSettingsStore((s) => s.builderIndexEnabled);
  const openBuilderIndexModal = useSettingsStore((s) => s.setBuilderIndexModalOpen);
  const onepasswordEnabled = useSettingsStore((s) => s.onepasswordEnabled);
  const onepasswordVaultId = useSettingsStore((s) => s.onepasswordVaultId);
  // [plugins] flags — Claude Code marketplace plugins pre-enabled for every agent.
  const pluginsEnabled = useSettingsStore((s) => s.pluginsEnabled);
  // What the installer is doing right now, per row — see `pluginHint`.
  const pluginInstallState = useSettingsStore((s) => s.pluginInstallState);

  const aiOff =
    aiFeatureMode({
      aiAutoRename,
      cloudDictation,
      aiComposer,
      aiSuggestedActions,
      aiAutoApprove,
      aiConcierge,
    }) === "off";

  const toggleTools: ToggleTool[] = [
    {
      // `...TOOL_META.x` first, rather than three field copies — see the note on SHOWCASE above for
      // both why it's a spread and why it leads.
      ...TOOL_META.deepgram,
      key: "deepgram",
      Icon: FiMic,
      url: "https://deepgram.com",
      ai: true,
      checked: cloudDictation,
      onToggle: () => void setAiFeature("voiceDictation", !cloudDictation),
    },
    {
      ...TOOL_META.guardrails,
      key: "guardrails",
      Icon: FiCheckCircle,
      checked: guardrailsEnabled,
      onToggle: () => void setToolEnabled("guardrails", !guardrailsEnabled),
    },
    {
      ...TOOL_META.roborev,
      key: "roborev",
      Icon: FiShield,
      // Surfaces the auth self-test result. Without this, a daemon that can't authenticate looks
      // exactly like a healthy one — it just never reviews anything.
      hint: roborevAuthWarning ?? undefined,
      checked: roborevEnabled,
      onToggle: () => void setRoborevEnabled(!roborevEnabled),
    },
    {
      ...TOOL_META.builderIndex,
      key: "builderIndex",
      Icon: FiTrendingUp,
      url: BUILDER_INDEX_URL,
      // Once it's on, the row is also the way back into the settings dialog (change username,
      // report now, turn off and forget) — otherwise the only route would be off-then-on, which
      // would make withdrawing consent a prerequisite for editing it.
      hint: builderIndexEnabled ? "Manage your Builder Index settings" : undefined,
      onHintClick: builderIndexEnabled ? () => openBuilderIndexModal(true) : undefined,
      checked: builderIndexEnabled,
      onToggle: () => void setBuilderIndexEnabled(!builderIndexEnabled),
    },
    {
      ...TOOL_META.superpowers,
      key: "superpowers",
      Icon: FiBookOpen,
      url: "https://github.com/obra/superpowers",
      hint: pluginHint(pluginInstallState.superpowers),
      checked: pluginsEnabled.superpowers,
      onToggle: () => void setPluginEnabled("superpowers", !pluginsEnabled.superpowers),
    },
    {
      ...TOOL_META.frontendDesign,
      key: "frontendDesign",
      Icon: FiLayout,
      url: FRONTEND_DESIGN_URL,
      hint: pluginHint(pluginInstallState.frontendDesign),
      checked: pluginsEnabled.frontendDesign,
      onToggle: () => void setPluginEnabled("frontendDesign", !pluginsEnabled.frontendDesign),
    },
    {
      ...TOOL_META.sparkleGuardrails,
      key: "sparkleGuardrails",
      Icon: FiShield,
      url: `${SPARKLE_MARKETPLACE_URL}/tree/main/plugins/sparkle-guardrails`,
      hint: pluginHint(pluginInstallState.sparkleGuardrails),
      checked: pluginsEnabled.sparkleGuardrails,
      onToggle: () =>
        void setPluginEnabled("sparkleGuardrails", !pluginsEnabled.sparkleGuardrails),
    },
    {
      ...TOOL_META.sparkleFreshness,
      key: "sparkleFreshness",
      Icon: FiGitBranch,
      url: `${SPARKLE_MARKETPLACE_URL}/tree/main/plugins/sparkle-freshness`,
      hint: pluginHint(pluginInstallState.sparkleFreshness),
      checked: pluginsEnabled.sparkleFreshness,
      onToggle: () => void setPluginEnabled("sparkleFreshness", !pluginsEnabled.sparkleFreshness),
    },
    {
      ...TOOL_META.sparkleMutationCheck,
      key: "sparkleMutationCheck",
      Icon: FiCheckSquare,
      url: `${SPARKLE_MARKETPLACE_URL}/tree/main/plugins/sparkle-mutation-check`,
      hint: pluginHint(pluginInstallState.sparkleMutationCheck),
      checked: pluginsEnabled.sparkleMutationCheck,
      onToggle: () =>
        void setPluginEnabled("sparkleMutationCheck", !pluginsEnabled.sparkleMutationCheck),
    },
    {
      ...TOOL_META.onepassword,
      key: "onepassword",
      Icon: FiLock,
      url: "https://developer.1password.com/docs/cli/",
      // Turning the tool on is not the same as it being usable: it needs the `op` CLI, the
      // desktop-app integration, and a chosen vault. Say which step is outstanding rather than
      // letting an on switch imply your secrets are being backed up when nothing is happening.
      hint: onepasswordEnabled && !onepasswordVaultId ? NO_VAULT_HINT : undefined,
      checked: onepasswordEnabled,
      onToggle: () => void setToolEnabled("onepassword", !onepasswordEnabled),
    },
    {
      ...TOOL_META.beads,
      key: "beads",
      Icon: FiShare2,
      url: "https://github.com/steveyegge/beads",
      checked: beadsEnabled,
      onToggle: () => void setToolEnabled("beads", !beadsEnabled),
    },
    {
      ...TOOL_META.github,
      key: "github",
      Icon: FiGithub,
      url: "https://github.com",
      checked: githubEnabled,
      onToggle: () => void setToolEnabled("github", !githubEnabled),
    },
    {
      ...TOOL_META.analytics,
      key: "analytics",
      Icon: FiBarChart2,
      url: "https://posthog.com",
      checked: analyticsEnabled,
      onToggle: () => void setToolEnabled("analytics", !analyticsEnabled),
    },
  ];

  const q = query.trim().toLowerCase();
  // The SAME matcher the rail used to decide this pane was worth showing — see engine/settingsSearch.
  // If these two ever diverge, the user gets a category that opens onto "No tools match".
  const matches = (name: string, desc: string, keywords = "") =>
    matchesSearch(`${name} ${desc} ${keywords}`, q);

  const shownToggles = toggleTools.filter((t) => matches(t.name, t.desc, t.keywords));
  const shownShowcase = SHOWCASE.filter((t) => matches(t.name, t.desc, t.keywords));

  if (q && shownToggles.length === 0 && shownShowcase.length === 0) {
    return <div style={emptyStyle}>No tools match “{query.trim()}”.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {shownToggles.length > 0 && (
        <section>
          <div style={groupLabel}>Your tools</div>
          {shownToggles.map((t) => (
            <ToolRow
              key={t.key}
              Icon={t.Icon}
              name={t.name}
              desc={t.desc}
              url={t.url}
              badge={t.ai ? { kind: "ai", text: "AI" } : undefined}
              hint={t.hint ?? (t.ai && aiOff ? AI_HINT : undefined)}
              onHintClick={t.onHintClick}
              control={
                <Switch
                  label={t.name}
                  // An AI row shows OFF and locks when the AI master is Off (the flag is already off
                  // in that state, but this makes the lock explicit and unmissable).
                  checked={t.ai ? t.checked && !aiOff : t.checked}
                  disabled={t.ai ? aiOff : false}
                  onToggle={t.onToggle}
                />
              }
            />
          ))}
        </section>
      )}

      {shownShowcase.length > 0 && (
        <section>
          <div style={groupLabel}>Built into Sparkle</div>
          {shownShowcase.map((t) => (
            <ToolRow
              key={t.name}
              Icon={t.Icon}
              name={t.name}
              desc={t.desc}
              url={t.url}
              // The badge is the right-hand control (in the switch's slot) — not also in the name row.
              control={<BadgePill kind={t.badge.kind}>{t.badge.text}</BadgePill>}
            />
          ))}
        </section>
      )}
    </div>
  );
}

// ── styles ──────────────────────────────────────────────────────────────────────────────────

const groupLabel: CSSProperties = { ...SECTION_LABEL, marginBottom: 6 };

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "10px 2px",
  borderBottom: `1px solid ${C.hairline}`,
};

const descStyle: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  lineHeight: 1.45,
  marginTop: 2,
};

const learnMoreStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  marginTop: 4,
  padding: 0,
  background: "transparent",
  border: "none",
  color: C.accentInk,
  cursor: "pointer",
  fontSize: 12,
  fontFamily: FONT_UI,
};

const hintStyle: CSSProperties = {
  fontSize: 12,
  color: C.amber,
  marginTop: 4,
  lineHeight: 1.4,
};

const hintButtonStyle: CSSProperties = {
  ...hintStyle,
  display: "inline-block",
  padding: 0,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: FONT_UI,
};

const emptyStyle: CSSProperties = {
  fontSize: 13,
  color: C.muted,
  padding: "8px 2px",
};
