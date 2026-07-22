import { type CSSProperties, type ComponentType, type ReactNode } from "react";
import {
  FiMessageSquare,
  FiMic,
  FiShare2,
  FiGithub,
  FiBarChart2,
  FiTerminal,
  FiShield,
  FiCheckCircle,
  FiBookOpen,
  FiExternalLink,
} from "react-icons/fi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { useSettingsStore, aiFeatureMode } from "../stores/settingsStore";
import { setAiFeature, setToolEnabled, setRoborevEnabled } from "../services/configActions";

// The "Tools" pane of the ⋯ settings dialog. Two groups:
//   • "Your tools"        — real on/off rows (config-backed). Off means the tool is used NOWHERE in
//                           Sparkle. Chief/Deepgram reuse the [ai] flags (brainstorm/voice_dictation)
//                           and carry an "AI" badge; the rest are [tools] flags.
//   • "Built into Sparkle" — showcase rows (icon + name + description + Learn-more + a badge, NO
//                           switch): the always-on capabilities that come with Sparkle.
// AI gating: when the AI master is Off (aiFeatureMode === "off"), the two AI rows are disabled +
// shown off with a hint — turning AI back on re-enables them (they ARE [ai] flags).
//
// The optional `query` prop mirrors the ⋯-dialog rail search: when set, rows whose name/description
// don't match are hidden (a group with no surviving rows disappears entirely).

const AI_HINT = "Turn on AI features to use this tool.";

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
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: FONT_WEIGHT.semibold,
        letterSpacing: 0.3,
        textTransform: "uppercase",
        background: p.bg,
        color: p.fg,
        border: `1px solid ${p.border}`,
        whiteSpace: "nowrap",
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
        borderRadius: 999,
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
}: {
  Icon: ComponentType<{ size?: number }>;
  name: string;
  desc: string;
  url?: string;
  badge?: Badge;
  control: ReactNode;
  hint?: string;
}) {
  return (
    <div style={rowStyle}>
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
        {hint && <div style={hintStyle}>{hint}</div>}
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
  checked: boolean;
  onToggle: () => void;
}

/** A showcase (built-in) tool: info + badge, never a switch. */
interface ShowcaseTool {
  Icon: ComponentType<{ size?: number }>;
  name: string;
  desc: string;
  url?: string;
  badge: Badge;
}

const SHOWCASE: ShowcaseTool[] = [
  {
    Icon: FiTerminal,
    name: "Claude Code",
    desc: "The agent engine behind every Sparkle agent.",
    url: "https://claude.com/claude-code",
    badge: { kind: "core", text: "Core" },
  },
  {
    Icon: FiBookOpen,
    name: "Superpowers",
    desc: "The skill library your agents use to plan, debug, and ship.",
    url: "https://github.com/obra/superpowers",
    badge: { kind: "builtin", text: "Built-in" },
  },
];

export function ToolsPane({ query = "" }: { query?: string }) {
  // AI flags: Deepgram = voiceDictation. The AI master derives from all of them.
  const aiAutoRename = useSettingsStore((s) => s.aiAutoRename);
  const cloudDictation = useSettingsStore((s) => s.cloudDictation);
  const aiComposer = useSettingsStore((s) => s.aiComposer);
  const aiSuggestedActions = useSettingsStore((s) => s.aiSuggestedActions);
  const aiAutoApprove = useSettingsStore((s) => s.aiAutoApprove);
  // [tools] flags.
  const analyticsEnabled = useSettingsStore((s) => s.analyticsEnabled);
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);
  const githubEnabled = useSettingsStore((s) => s.githubEnabled);
  const guardrailsEnabled = useSettingsStore((s) => s.guardrailsEnabled);
  const roborevEnabled = useSettingsStore((s) => s.roborevEnabled);
  const roborevAuthWarning = useSettingsStore((s) => s.roborevAuthWarning);

  const aiOff =
    aiFeatureMode({
      aiAutoRename,
      cloudDictation,
      aiComposer,
      aiSuggestedActions,
      aiAutoApprove,
    }) === "off";

  const toggleTools: ToggleTool[] = [
    {
      key: "deepgram",
      Icon: FiMic,
      name: "Deepgram voice",
      desc: "Cloud dictation (Nova). Off falls back to on-device speech.",
      url: "https://deepgram.com",
      ai: true,
      checked: cloudDictation,
      onToggle: () => void setAiFeature("voiceDictation", !cloudDictation),
    },
    {
      key: "guardrails",
      Icon: FiCheckCircle,
      name: "Guardrails",
      desc: "Opinionated quality workflow for the code Sparkle writes: test-first, run the tests and typechecks before committing, and never call a red build done. Off removes it.",
      checked: guardrailsEnabled,
      onToggle: () => void setToolEnabled("guardrails", !guardrailsEnabled),
    },
    {
      key: "roborev",
      Icon: FiShield,
      name: "Roborev",
      desc: "Per-commit AI code review of your BUILD agents' commits, using your Claude login.",
      // Surfaces the auth self-test result. Without this, a daemon that can't authenticate looks
      // exactly like a healthy one — it just never reviews anything.
      hint: roborevAuthWarning ?? undefined,
      checked: roborevEnabled,
      onToggle: () => void setRoborevEnabled(!roborevEnabled),
    },
    {
      key: "beads",
      Icon: FiShare2,
      name: "Beads",
      desc: "The in-repo work graph behind the Plan board.",
      url: "https://github.com/steveyegge/beads",
      checked: beadsEnabled,
      onToggle: () => void setToolEnabled("beads", !beadsEnabled),
    },
    {
      key: "github",
      Icon: FiGithub,
      name: "GitHub import",
      desc: "Pull a project straight from your GitHub repositories.",
      url: "https://github.com",
      checked: githubEnabled,
      onToggle: () => void setToolEnabled("github", !githubEnabled),
    },
    {
      key: "analytics",
      Icon: FiBarChart2,
      name: "Usage analytics",
      desc: "Anonymous usage + masked session replay that help improve Sparkle. Off sends nothing.",
      url: "https://posthog.com",
      checked: analyticsEnabled,
      onToggle: () => void setToolEnabled("analytics", !analyticsEnabled),
    },
  ];

  const q = query.trim().toLowerCase();
  const matches = (name: string, desc: string) =>
    !q || `${name} ${desc}`.toLowerCase().includes(q);

  const shownToggles = toggleTools.filter((t) => matches(t.name, t.desc));
  const shownShowcase = SHOWCASE.filter((t) => matches(t.name, t.desc));

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

const groupLabel: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: C.muted,
  fontWeight: FONT_WEIGHT.semibold,
  marginBottom: 6,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "10px 2px",
  borderBottom: `1px solid ${C.forest}`,
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
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const hintStyle: CSSProperties = {
  fontSize: 11,
  color: C.amber,
  marginTop: 4,
  lineHeight: 1.4,
};

const emptyStyle: CSSProperties = {
  fontSize: 13,
  color: C.muted,
  padding: "8px 2px",
};
