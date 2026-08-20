import { useMemo, useState, type CSSProperties } from "react";
import { FiAlertTriangle, FiLock, FiShield } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS, TYPE } from "../theme/scale";
import { SECTION_LABEL, tag } from "./labelTreatment";
import { useSettingsStore } from "../stores/settingsStore";
import {
  CONCIERGE_TOOL_GROUPS,
  MERGE_PROTECTED_SLUGS,
  NO_TOOL_POLICY_OVERRIDES,
  POLICY_DECISIONS,
  POLICY_DECISION_LABEL,
  POLICY_STRICTNESS,
  conciergeToolConfigPath,
  evaluateToolPolicy,
  isForeignSlug,
  isPinnedMergeProtectedSlug,
  projectPolicyContextFor,
  toToolPolicyOverrides,
  type ConciergeToolEntry,
  type PolicyDecision,
  type ToolPolicyEvaluation,
  type ToolPolicyOverrides,
} from "../services/conciergeTools/policy";

// THE PER-PROJECT HALF of the ⋯ Settings → "Concierge tools" pane (bead `sparkle-gylxbo`, contract
// §3). The global pane answers "what may the concierge do"; this answers the question the strictness
// lattice made askable — "what may it do HERE, and who decided that".
//
// A POLICY THE OWNER CANNOT SEE IS ONE HE CANNOT TRUST, which is the whole reason this file exists
// rather than the lattice shipping headless. `evaluateToolPolicy` already resolves
// `strictest(base, pinnedFloor, foreignFloor, projectTier)` and hands back a
// `ToolPolicyProjectAttribution` carrying the INHERITED answer beside the effective one. Every
// sentence below is rendered from that one object. Nothing here re-derives a decision, and nothing
// here keeps a second table of what a decision means — a second description of the same decision is
// the one that goes stale, and it goes stale silently because both halves keep rendering.
//
// THE ONE RULE THE UI MUST NOT BREAK: a project can only TIGHTEN. The lattice takes the strictest
// contributor, so a project entry LOOSER than what the floors already impose is not an error and is
// not reported — it is simply ignored. A dropdown that offers such a tier is therefore a control
// that lies: the user picks "Allow", the file records "allow", and nothing changes. So the offerable
// set is computed from the BASELINE — this project's answer with its own overrides removed, i.e.
// everything that cannot be lowered from here (the global answer, the pinned floor, the foreign
// floor) — and anything below it is never rendered at all. See `offerableDecisions`.
//
// WHICH IS ALSO WHY A PINNED REPO NEEDS NO SPECIAL CASE IN THE CONTROL. `merge_pr` in a
// merge-protected repo has a baseline of `deny`, so `deny` is the only offerable tier and the
// segment collapses to it on its own. The badge exists to say WHY in words; the control's honesty
// falls out of the lattice.

/** The pane's current scope: `null` = every project (the global pane), otherwise a repo slug. */
export type PolicyScope = string | null;

/** The `<select>` value that opens the free-text slug entry. Not a slug — `owner/repo` always
 *  contains a `/`, so this can never collide with a real one. */
export const OTHER_SCOPE_VALUE = "__other__";
/** The `<select>` value for the global pane. Same non-collision argument as above. */
export const ALL_SCOPE_VALUE = "__all__";

/** Ids the project rows point `aria-describedby` at, so the two facts that govern EVERY row on the
 *  screen are stated once rather than sixty-two times. Repeating "projects can only tighten" under
 *  each row would bury the row's own sentence, which is the one that differs. */
const TIGHTEN_NOTE_ID = "concierge-project-tighten-note";
const PROTECTED_NOTE_ID = "concierge-project-protected-note";

/** The sentence the brief requires beside the per-project control, verbatim. Exported so the test
 *  asserts the string the pane renders rather than a paraphrase of it. */
export const TIGHTEN_ONLY_NOTE =
  "Projects can only tighten. To loosen, change All projects.";

// ---------------------------------------------------------------------------------------------
// Reading the store DEFENSIVELY
// ---------------------------------------------------------------------------------------------
//
// `conciergeOwnOrgs` and `conciergeProjectPolicy` are hydrated by config.rs → services/config →
// settingsStore, and that chain lands separately from this pane. Read through a probe with a safe
// default rather than a typed field, so this compiles and behaves sanely on a build where the
// hydration is not there yet: no orgs means EVERY repo is foreign, which floors merge-class tools at
// `ask` — exactly today's global stopgap, and the fail-closed direction. An empty project table
// means every row reads "inherited", which is true.

/** The shape we PROBE the settings store for. Every field optional: this is what a store predating
 *  the hydration actually holds, and describing it as required would be a shape the app cannot
 *  produce. */
interface ConciergePolicyStateProbe {
  conciergeOwnOrgs?: unknown;
  conciergeProjectPolicy?: unknown;
}

/** `[concierge].own_orgs` as strings, lowercased and trimmed. Anything else is dropped rather than
 *  coerced — an org we cannot read is an org we do not own, which is the safe reading. */
export function narrowOwnOrgs(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim().toLowerCase();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** `[concierge.projects]` as slug → that project's tool table. Reuses `toToolPolicyOverrides` so
 *  the drop-non-strings discipline is the module's, not a second copy of it. */
export function narrowProjectPolicy(
  raw: unknown,
): Readonly<Record<string, ToolPolicyOverrides>> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ToolPolicyOverrides> = {};
  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = slug.trim().toLowerCase();
    if (key.length === 0) continue;
    // Both shapes: the store may hold the tool table directly, or the `{ tools }` wrapper the wire
    // uses. Probing for `tools` rather than assuming one keeps this correct either way.
    const inner =
      value && typeof value === "object" && "tools" in (value as Record<string, unknown>)
        ? (value as Record<string, unknown>).tools
        : value;
    out[key] = toToolPolicyOverrides(inner);
  }
  return out;
}

/**
 * The three raw values this pane needs, narrowed once.
 *
 * Selects the RAW fields and narrows inside `useMemo` on purpose: a zustand selector that built a
 * fresh array or object on every call would hand `useSyncExternalStore` a new snapshot each render
 * and spin. `undefined` — the pre-hydration value — is a stable reference, so the un-wired build is
 * the cheap case rather than the pathological one.
 */
export function useConciergeProjectPolicy(): {
  ownOrgs: readonly string[];
  projectPolicy: Readonly<Record<string, ToolPolicyOverrides>>;
} {
  const rawOrgs = useSettingsStore((s) => (s as ConciergePolicyStateProbe).conciergeOwnOrgs);
  const rawProjects = useSettingsStore(
    (s) => (s as ConciergePolicyStateProbe).conciergeProjectPolicy,
  );
  const ownOrgs = useMemo(() => narrowOwnOrgs(rawOrgs), [rawOrgs]);
  const projectPolicy = useMemo(() => narrowProjectPolicy(rawProjects), [rawProjects]);
  return { ownOrgs, projectPolicy };
}

// ---------------------------------------------------------------------------------------------
// The scope list
// ---------------------------------------------------------------------------------------------

/**
 * Every repo the switcher offers, deduped and sorted.
 *
 * TWO SOURCES, and the pinned one is not an optimisation. A merge-protected repo must be reachable
 * on this pane BEFORE anyone has configured it, because the thing the user needs to see there is
 * precisely that they cannot configure it: the pin is compiled into the build and the pane is the
 * only place that says so. Offering only repos that already have a rule would hide exactly the
 * repos whose rule is not theirs to write.
 *
 * Anything else is one typed slug away — see `OTHER_SCOPE_VALUE`.
 */
export function policyScopeSlugs(
  configured: readonly string[],
  pinned: readonly string[] = MERGE_PROTECTED_SLUGS,
): readonly string[] {
  const seen = new Set<string>();
  for (const s of [...pinned, ...configured]) {
    const normalized = normalizeScopeSlug(s);
    if (normalized !== null) seen.add(normalized);
  }
  return [...seen].sort();
}

/** `owner/repo` lowercased, or null when the text is not that shape.
 *
 *  Delegates to `projectPolicyContextFor`, which owns the normalizer, rather than re-implementing
 *  it: a second parser is a second set of edge cases, and this one decides which config KEY a write
 *  lands under. A slug the pane normalized differently from the evaluator would show one repo's
 *  policy while writing another's. */
export function normalizeScopeSlug(raw: string | null | undefined): string | null {
  return projectPolicyContextFor(raw ?? null, [], {}).slug;
}

// ---------------------------------------------------------------------------------------------
// The lattice, as UI
// ---------------------------------------------------------------------------------------------

/**
 * The tiers a project rule can actually reach, given a baseline it cannot go below.
 *
 * Ordered by `POLICY_DECISIONS` (the render order) and filtered by `POLICY_STRICTNESS` (the
 * semantics). Neither is written out here: an order typed into this file is one that stops matching
 * the lattice the first time the vocabulary changes, and the failure would be a dropdown quietly
 * offering a tier the evaluator ignores — the exact defect this function exists to prevent.
 */
export function offerableDecisions(baseline: PolicyDecision): readonly PolicyDecision[] {
  return POLICY_DECISIONS.filter((d) => POLICY_STRICTNESS[d] >= POLICY_STRICTNESS[baseline]);
}

/**
 * WHERE THE ANSWER CAME FROM, in three words.
 *
 * Asked as a PROPERTY of the attribution rather than as membership of a list of sources: everything
 * that is not one of the three project-layer contributors IS the inherited global answer, by
 * construction of `applyProjectPolicyLayer` (it keeps `base.source` unless the project layer
 * tightened). So a source added to the union later falls into "inherited" and is still correct,
 * where a switch enumerating today's values would silently stop covering it.
 */
export function policyOriginLabel(evaluation: ToolPolicyEvaluation): string {
  switch (evaluation.source) {
    case "project-override":
    case "unreadable-project-override":
      return "This project’s rule";
    case "pinned-repo":
      return "Merge-protected repo";
    case "foreign-repo":
      return "Not one of your orgs";
    default:
      return "Inherited from All projects";
  }
}

/** Everything one row needs, resolved from the policy module and nothing else. */
export interface ProjectRowPolicy {
  /** What is actually in force for this tool in this repo. */
  readonly evaluation: ToolPolicyEvaluation;
  /** The floor a project rule cannot go below: this repo's answer with its own overrides removed. */
  readonly baseline: PolicyDecision;
  /** The tiers the control may offer. Never empty — `deny` is always at or above any baseline. */
  readonly offerable: readonly PolicyDecision[];
}

/**
 * Resolve one tool for one repo.
 *
 * THE BASELINE IS A SECOND EVALUATION, not arithmetic on the first, and that is the point. "What
 * can a project rule not undo?" is answered by asking the evaluator the same question with the
 * project's own table emptied — so the pinned floor, the foreign floor and the global answer all
 * reach it through the code that owns them. Deriving it from `inheritedDecision` alone would miss
 * both floors: in a merge-protected repo the inherited answer is `Allow` while the reachable floor
 * is `Never`, and a dropdown built on the former would offer two tiers that do nothing.
 */
export function resolveProjectRowPolicy(
  tool: string,
  overrides: ToolPolicyOverrides,
  slug: string,
  ownOrgs: readonly string[],
  projectPolicy: Readonly<Record<string, ToolPolicyOverrides>>,
): ProjectRowPolicy {
  const ctx = projectPolicyContextFor(slug, ownOrgs, projectPolicy);
  const evaluation = evaluateToolPolicy(tool, { overrides, project: ctx });
  const baseline = evaluateToolPolicy(tool, {
    overrides,
    project: { ...ctx, overrides: NO_TOOL_POLICY_OVERRIDES },
  }).decision;
  return { evaluation, baseline, offerable: offerableDecisions(baseline) };
}

/**
 * Write (or clear) one project's rule for one tool.
 *
 * `services/config` is imported LAZILY rather than at module scope. That module reaches the Tauri
 * runtime, and this component is rendered by a pane whose existing test suite mocks
 * `services/configActions` instead — pulling the runtime in at import time would make an unrelated
 * suite depend on it. Deferring it to the click keeps the module graph the pane already had.
 *
 * Nothing is mirrored into the store optimistically, unlike the global rows: the store field this
 * writes to is hydrated from the config file by another seam, and a mirror written here would be a
 * second writer for a value with one owner. The `config-changed` the write emits re-hydrates it.
 */
export async function setProjectToolPolicy(
  slug: string,
  tool: string,
  decision: PolicyDecision | null,
): Promise<void> {
  const path = conciergeToolConfigPath(tool, slug);
  try {
    const config = await import("../services/config");
    if (decision) await config.setConfigValue(path, decision);
    else await config.unsetConfigValue(path);
  } catch (e) {
    console.warn("config write failed (concierge project tool policy)", e);
  }
}

// ---------------------------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------------------------

/**
 * "Policy for: [ All projects ▾ ]" — the pane's one new control.
 *
 * A `<select>` rather than a bespoke menu: it is a scope switch, not a decision, and the platform
 * control is the one every user already knows how to drive. "Another repo…" is the escape hatch for
 * a repo that neither ships pinned nor has a rule yet.
 */
export function ConciergePolicyScopeBar({
  scope,
  slugs,
  onScope,
}: {
  scope: PolicyScope;
  slugs: readonly string[];
  onScope: (next: PolicyScope) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  // A scope reached through "Another repo…" is not in `slugs`, so it is appended rather than lost —
  // otherwise the `<select>` would fall back to its first option and silently move the user off the
  // repo they just named.
  const options = scope !== null && !slugs.includes(scope) ? [...slugs, scope].sort() : slugs;

  const commit = () => {
    const normalized = normalizeScopeSlug(draft);
    if (normalized === null) return;
    setTyping(false);
    setDraft("");
    onScope(normalized);
  };

  return (
    <div style={scopeBar} data-testid="concierge-policy-scope-bar">
      <label style={scopeLabel} htmlFor="concierge-policy-scope">
        Policy for
      </label>
      <select
        id="concierge-policy-scope"
        data-testid="concierge-policy-scope"
        style={scopeSelect}
        value={scope ?? ALL_SCOPE_VALUE}
        onChange={(e) => {
          const v = e.target.value;
          if (v === OTHER_SCOPE_VALUE) {
            setTyping(true);
            return;
          }
          setTyping(false);
          if (v === ALL_SCOPE_VALUE) {
            onScope(null);
            return;
          }
          // NORMALIZED, AND A NON-SLUG IS A NO-OP rather than a scope. A `<select>` handed a value
          // it has no option for reports `""`, and an empty string is not null — it would sail past
          // the pane's `scope !== null` check and render a project screen for a repo with no name,
          // whose writes would land on the GLOBAL `concierge.tools.<tool>` key. Refusing here means
          // the worst an unknown value can do is nothing.
          const slug = normalizeScopeSlug(v);
          if (slug !== null) onScope(slug);
        }}
      >
        <option value={ALL_SCOPE_VALUE}>All projects</option>
        {options.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
        <option value={OTHER_SCOPE_VALUE}>Another repo…</option>
      </select>
      {typing && (
        <>
          <input
            data-testid="concierge-policy-scope-input"
            aria-label="Repository, as owner/repo"
            placeholder="owner/repo"
            style={scopeInput}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
          />
          <button type="button" style={scopeGoBtn} onClick={commit}>
            Use
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The per-project screen: one header stating the two facts that govern every row, then the same
 * tool rows the global pane shows, each carrying its effective tier, the inherited one, and where
 * the difference came from.
 */
export function ConciergeProjectPolicyPane({
  slug,
  overrides,
  ownOrgs,
  projectPolicy,
  gated,
}: {
  slug: string;
  overrides: ToolPolicyOverrides;
  ownOrgs: readonly string[];
  projectPolicy: Readonly<Record<string, ToolPolicyOverrides>>;
  gated: boolean;
}) {
  const pinned = isPinnedMergeProtectedSlug(slug);
  const foreign = !pinned && isForeignSlug(slug, ownOrgs);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {pinned && (
        <div style={protectedBox} role="note" data-testid="concierge-merge-protected-badge">
          <span style={protectedHead}>
            <FiLock size={12} aria-hidden /> Merge-protected repo
          </span>
          <p id={PROTECTED_NOTE_ID} style={protectedBody}>
            Sparkle will never merge in <code style={slugCode}>{slug}</code> on its own authority,
            whatever the settings say. The remedy is to hand the merge to a human — this is shipped
            with the app, so there is nothing here to loosen.
          </p>
        </div>
      )}
      {foreign && (
        <div style={protectedBox} role="note" data-testid="concierge-merge-protected-badge">
          <span style={protectedHead}>
            <FiShield size={12} aria-hidden /> Merge-protected repo
          </span>
          <p id={PROTECTED_NOTE_ID} style={protectedBody}>
            <code style={slugCode}>{slug}</code> isn’t one of your own repos, so anything that
            touches its main branch asks you first. Add the org to{" "}
            <code style={slugCode}>[concierge].own_orgs</code> in config.toml if it is yours.
          </p>
        </div>
      )}
      <div style={noticeBox} id={TIGHTEN_NOTE_ID} data-testid="concierge-tighten-note">
        {TIGHTEN_ONLY_NOTE} Each row shows what is in force here, what you set for every project, and
        which of the two decided it.
      </div>
      {CONCIERGE_TOOL_GROUPS.map((group) => (
        <section
          key={group.domain}
          style={{ display: "flex", flexDirection: "column", gap: 12, opacity: gated ? 0.55 : 1 }}
        >
          <h3 style={groupHeading}>{group.label}</h3>
          {group.tools.map((tool) => (
            <ProjectToolRow
              key={tool.name}
              tool={tool}
              slug={slug}
              policy={resolveProjectRowPolicy(
                tool.name,
                overrides,
                slug,
                ownOrgs,
                projectPolicy,
              )}
              gated={gated}
              protectedNote={pinned || foreign}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/** One tool, for one repo: the tier in force, the tier inherited, the origin, and a control that
 *  can only reach tiers the lattice would actually honour. */
function ProjectToolRow({
  tool,
  slug,
  policy,
  gated,
  protectedNote,
}: {
  tool: ConciergeToolEntry;
  slug: string;
  policy: ProjectRowPolicy;
  gated: boolean;
  protectedNote: boolean;
}) {
  const { evaluation, offerable } = policy;
  const attribution = evaluation.project;
  const unreadable =
    evaluation.source === "unreadable-override" ||
    evaluation.source === "unreadable-project-override";
  // Same rule the global row uses: a value the file does not hold must not be drawn as pressed.
  const selected: PolicyDecision | null = unreadable ? null : evaluation.decision;
  const hasProjectRule = attribution?.projectEntry != null;
  const describedBy = [protectedNote ? PROTECTED_NOTE_ID : null, TIGHTEN_NOTE_ID]
    .filter(Boolean)
    .join(" ");

  return (
    <div style={row} data-testid="concierge-project-tool-row">
      <div
        style={{ display: "flex", flexDirection: "column", gap: 3, flex: "1 1 auto", minWidth: 0 }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}
        >
          <span style={toolName}>{tool.name}</span>
          <span style={riskPill} title={`Risk: ${tool.riskClass}`}>
            {tool.riskClass}
          </span>
          <span style={originPill} data-testid="concierge-project-origin">
            {policyOriginLabel(evaluation)}
          </span>
          {unreadable && (
            <span style={warnPill} title={evaluation.reason}>
              <FiAlertTriangle size={11} /> unreadable
            </span>
          )}
        </div>
        {/* THE TWO TIERS, SIDE BY SIDE. The effective one is what happens; the inherited one is what
            would happen without this repo's floors and rules. Showing only the first turns a
            tightened row into an unexplained refusal, which is how a user concludes the pane is
            broken and reaches for the config file. */}
        <div style={tierLine}>
          <span data-testid="concierge-project-effective">
            <span style={tierCaption}>In force here</span>{" "}
            <strong style={tierValue}>{POLICY_DECISION_LABEL[evaluation.decision]}</strong>
          </span>
          <span style={tierSep} aria-hidden>
            ·
          </span>
          <span data-testid="concierge-project-inherited">
            <span style={tierCaption}>All projects</span>{" "}
            <span style={inheritedValue}>
              {POLICY_DECISION_LABEL[
                attribution?.inheritedDecision ?? evaluation.decision
              ]}
            </span>
          </span>
        </div>
        {/* WHY, in the policy layer's own words. Not a sentence assembled here from `source`: the
            evaluator already authored one that names the slug, the tier and the lever, and a second
            author would drift from it the first time the lattice changed. */}
        <span
          data-testid="concierge-project-reason"
          style={{ color: unreadable ? C.amber : C.muted, fontSize: 12, lineHeight: 1.45 }}
        >
          {evaluation.reason}
        </span>
      </div>
      <div style={controlCell} data-testid="concierge-project-control">
        <div style={resetSlot}>
          {hasProjectRule && (
            <button
              type="button"
              className={LINK_CLASS}
              aria-label={`Clear the ${slug} rule for ${tool.name}`}
              title={`Drop this project's rule and inherit ${POLICY_DECISION_LABEL[attribution?.inheritedDecision ?? evaluation.decision]}`}
              disabled={gated}
              style={linkBtn}
              onClick={() => {
                if (gated) return;
                void setProjectToolPolicy(slug, tool.name, null);
              }}
            >
              Reset
            </button>
          )}
        </div>
        {/* ONLY the tiers the lattice would honour. A looser one is not disabled here, it is not
            rendered — a greyed button still says "this tier exists for this repo", and it does
            not. */}
        <div
          style={segment}
          data-testid="concierge-project-segment"
          role="group"
          aria-label={`${tool.name} permission for ${slug}`}
          aria-describedby={describedBy}
        >
          {offerable.map((decision, i) => (
            <button
              key={decision}
              type="button"
              aria-pressed={selected === decision}
              disabled={gated}
              aria-describedby={describedBy}
              style={segmentBtn(selected === decision, i === 0, gated)}
              onClick={() => {
                if (gated) return;
                void setProjectToolPolicy(slug, tool.name, decision);
              }}
            >
              {POLICY_DECISION_LABEL[decision]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- styles (borrowed from ConciergeToolsPane so the two scopes read as one pane) ---------------

const scopeBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  background: C.forest,
  border: `1px solid ${C.hairline}`,
  borderRadius: 6,
  padding: "8px 10px",
};

const scopeLabel: CSSProperties = {
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  color: C.cream,
};

const scopeSelect: CSSProperties = {
  background: C.forest,
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: RADIUS.input,
  padding: "4px 8px",
  fontSize: 12,
  fontFamily: FONT_UI,
  cursor: "pointer",
  maxWidth: 280,
};

const scopeInput: CSSProperties = {
  background: C.forest,
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: RADIUS.input,
  padding: "4px 8px",
  fontSize: 12,
  fontFamily: FONT_MONO,
  minWidth: 160,
};

const scopeGoBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: RADIUS.input,
  padding: "4px 12px",
  fontSize: 12,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: FONT_UI,
  cursor: "pointer",
};

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "nowrap",
  gap: 12,
  paddingBottom: 12,
  borderBottom: `1px solid ${C.hairline}`,
};

const groupHeading: CSSProperties = { ...SECTION_LABEL, margin: 0 };

const toolName: CSSProperties = {
  color: C.cream,
  fontWeight: FONT_WEIGHT.semibold,
  fontSize: 13,
  fontFamily: FONT_MONO,
  overflowWrap: "anywhere",
};

const noticeBox: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  lineHeight: 1.5,
  background: C.forest,
  border: `1px solid ${C.hairline}`,
  borderRadius: 6,
  padding: "8px 10px",
};

const protectedBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  background: C.forest,
  border: `1px solid ${C.amber}`,
  borderRadius: 6,
  padding: "10px 12px",
};

const protectedHead: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  color: C.amber,
};

const protectedBody: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: C.cream,
};

// Mono at the prose size, not a step below it. 11 was off the TYPE scale entirely (the scale is
// 10/12/13/17), and the sibling pane this file borrows from sets inline mono at its own body
// size for the same reason: the mono face already marks the span as code, so shrinking it as
// well makes a slug harder to read in the one sentence that asks the user to act on it.
const slugCode: CSSProperties = { fontFamily: FONT_MONO, fontSize: TYPE.small };

const tierLine: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
  fontSize: 12,
  color: C.muted,
};

const tierCaption: CSSProperties = { color: C.muted, fontSize: TYPE.small };
const tierValue: CSSProperties = { color: C.cream, fontWeight: FONT_WEIGHT.semibold };
const inheritedValue: CSSProperties = { color: C.muted };
const tierSep: CSSProperties = { color: C.hairline };

function pill(color: string): CSSProperties {
  return { display: "inline-flex", alignItems: "center", ...tag(color), gap: 3 };
}

const riskPill = pill(C.muted);
const originPill = pill(C.teal);
const warnPill = pill(C.amber);

// Same three numbers as the global rows — see ConciergeToolsPane's note on why they are what they
// are. Repeated rather than exported because the two panes' columns must be free to diverge if the
// per-project row ever needs a fourth affordance; today they are deliberately identical so
// switching scope does not move the controls under the cursor.
const SEGMENT_W = 170;
const RESET_W = 38;
const CONTROL_GAP = 6;
const CONTROL_W = RESET_W + CONTROL_GAP + SEGMENT_W;

const controlCell: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: CONTROL_GAP,
  flex: `0 0 ${CONTROL_W}px`,
  flexWrap: "nowrap",
};

const resetSlot: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "center",
  flex: `0 0 ${RESET_W}px`,
};

const segment: CSSProperties = {
  display: "flex",
  flexWrap: "nowrap",
  flex: `0 0 ${SEGMENT_W}px`,
  width: SEGMENT_W,
  border: `1px solid ${C.muted}`,
  borderRadius: RADIUS.input,
  overflow: "hidden",
};

function segmentBtn(active: boolean, first: boolean, gated: boolean): CSSProperties {
  return {
    flex: "1 1 auto",
    minWidth: 0,
    background: active ? C.teal : "transparent",
    color: active ? ON_BRAND_FILL : C.cream,
    border: "none",
    borderLeft: first ? "none" : `1px solid ${C.muted}`,
    borderRadius: 0,
    padding: "5px 4px",
    fontSize: 12,
    fontFamily: FONT_UI,
    cursor: gated ? "default" : "pointer",
    whiteSpace: "nowrap",
  };
}

const LINK_CLASS = "settings-link-btn";

const linkBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  fontSize: 12,
  fontFamily: FONT_UI,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
