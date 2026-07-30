import { useEffect, useState, type CSSProperties } from "react";
import { FiAlertTriangle, FiSlash } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { SettingCheckbox } from "./SettingCheckbox";
import { ModalShell } from "./ModalShell";
import {
  allowAllConciergeTools,
  resetAllConciergeTools,
  setConciergeToolPolicy,
} from "../services/configActions";
import {
  useConciergeAiAccess,
  turnOnConciergeAi,
  type ConciergeAiRemedy,
} from "../services/conciergeAiAccess";
import { AI_ENHANCEMENTS_GRADIENT } from "./AiEnhancementsBadge";
import { AiLockedNotice } from "./AiLockedNotice";
import { ConciergeAuditPane } from "./ConciergeAuditPane";
import { RefillLink } from "./OutOfCreditsNotice";
import {
  CONCIERGE_TOOL_CATALOG,
  CONCIERGE_TOOL_GROUPS,
  POLICY_DECISIONS,
  POLICY_DECISION_LABEL,
  evaluateToolPolicy,
  type ConciergeToolEntry,
  type PolicyDecision,
  type ToolPolicyEvaluation,
} from "../services/conciergeTools/policy";

import { FONT_MONO, FONT_UI, RADIUS, TYPE } from "../theme/scale";
import { SECTION_LABEL, tag } from "./labelTreatment";
// The ⋯ Settings → "Concierge tools" pane: every tool the concierge can invoke, grouped by domain,
// each with an allow / ask first / never control.
//
// PER-TOOL IS THE POINT. There is deliberately no master autonomy slider at the top of this pane —
// one dial would have to be set to the strictness of the most dangerous tool it governs, which is
// how "let it read my terminals" and "never let it merge a PR" end up sharing a number. What plays
// that role instead is the DEFAULT column: every tool starts on a decision derived from the risk
// its tool domain already classifies it with, so the pane is usable without touching a single row.
//
// Every row states three things, because a permission control the user can't reason about gets set
// once and never revisited: what the tool DOES, how risky its domain says it is, and whether the
// current value is the derived default or something the user chose. Rows the user has set carry a
// "Set by you" pill and a reset control; the rest read "…by default".
//
// Reads come from the settings mirror of `[concierge.tools]`; every write goes through
// configActions (the TOML file is the source of truth) and clears the key rather than writing a
// value when the user resets a row — the default is derived, so freezing today's value into the
// file would quietly stop tracking a future reclassification.
//
// WITHOUT AI ENHANCEMENTS THE CONCIERGE CANNOT ACT AT ALL, and the pane says so ONCE. Every row
// still renders — greyed and read-only, but carrying its real name, risk and current value —
// because those rows ARE the argument for turning enhancements on: this is what you would be able
// to tune. Fifty per-row errors would bury that argument under noise about a single fact with a
// single remedy, which is why the policy layer reports one shared cause rather than fifty.
//
// THE CONTROL COLUMN IS A FIXED WIDTH, AND THAT IS THE WHOLE FIX for how this pane used to read.
// The three options are ONE segmented control that must never wrap, so the column reserves
// `CONTROL_W` on every row — a Reset slot plus the segment — and the description column takes what
// is left. Before that, the buttons sat in a `flexWrap: "wrap"` bag sized by whatever the summary
// left over: 38 of 62 rows dropped "Never" onto a second line, and "Allow" started at three
// different x-positions down the page depending on the row's label length, badge count, and whether
// it carried a Reset. It read as broken rather than as a design. The Reset slot is reserved whether
// or not the row has one, because the alternative — letting Reset push the segment left — is the
// same bug in a smaller costume. Only the DESCRIPTION may wrap.
//
// RESET IS A LINK, NOT A BUTTON. It is the undo for a decision, not a fourth thing you can decide,
// and drawing it in the same bordered box as Allow / Ask first / Never both said otherwise and cost
// the row the width that made the segment wrap. It stays a real <button> element — it performs an
// action, so that is the honest role — styled as text.
//
// ONE BULK CONTROL, ONE CONFIRMATION. "Allow everything" is deliberately not split into a routine
// tier and an everything tier: a second variant hands back exactly the decision the button exists
// to skip. Nothing the grant covers is hidden either — the confirmation names how many irreversible
// tools there are AND the ones that read the user's screen, which is what the taxonomy is FOR: the
// risk classes exist so this sentence can be true, and a class the sentence omits is a class nobody
// consented to. It is paired with "Reset all to defaults" so the whole
// gesture is reversible in one, and a bulk apply writes an explicit rule per tool so every affected
// row still reads "set by you" with its own Reset (see allowAllConciergeTools for why).
//
// AND THE SAVED RULES SURVIVE. Gating is a PRESENTATION state: nothing here writes, clears, or
// reinterprets `[concierge.tools]` while enhancements are off, so a row the human set still reads
// "set by you" and still shows their value. Switching enhancements off and back on restores their
// configuration exactly — a settings pane that silently resets someone's rules is the kind of bug
// people never forgive, and ConciergeToolsPane.test.tsx pins it.

export function ConciergeToolsPane() {
  const overrides = useSettingsStore((s) => s.conciergeToolPolicy);
  // ONE fact, from the one seam that also knows WHICH of the three remedies this user needs.
  const access = useConciergeAiAccess();
  const gated = !access.enabled;
  // The one PRESENTATION preference on this pane, and the only control here that is NOT gated by AI
  // enhancements: it governs a gesture in the concierge column, not anything the concierge may do.
  // Hence uiStore rather than settingsStore + config.toml — see the store's own note on the split.
  const copyOnSelection = useUiStore((s) => s.conciergeCopyOnSelection);
  const setCopyOnSelection = useUiStore((s) => s.setConciergeCopyOnSelection);
  const autoSendTuner = useUiStore((s) => s.conciergeAutoSendTuner);
  const setAutoSendTuner = useUiStore((s) => s.setConciergeAutoSendTuner);
  // Which bulk action is awaiting confirmation, if any. Null = no dialog.
  const [pending, setPending] = useState<BulkAction | null>(null);
  // THE GATE CLOSING CANCELS THE INTENT, not just its rendering. `gated` is a live read — the
  // AI-features flag, entitlement, and a credit balance that a background `me` refresh can move —
  // so it flips on its own while a dialog is up. Merely refusing to RENDER the confirmation would
  // leave `pending` set: the scrim vanishes (which reads as "cancelled"), the next poll restores
  // credit, and a destructive 62-rule confirmation pops back over the pane unrequested with its
  // primary button live. A stray Enter there grants every tool, including the 8 irreversible ones,
  // from a gesture the human never re-initiated.
  useEffect(() => {
    if (gated) setPending(null);
  }, [gated]);
  // How many rules the human has actually set — what "Reset all" would discard, and whether there
  // is anything for it to do at all.
  const ruleCount = Object.keys(overrides).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {gated && <AiEnhancementsGate remedy={access.remedy} />}
      {/* WHAT IT DID, above what it MAY do — the same question in two tenses, and this is the tense
          people arrive on this pane asking about ("why didn't it merge the PR?"). Ungated on
          purpose: the record of what already happened does not stop being true when enhancements
          go off, and it renders its own empty state when there is nothing to show. */}
      <ConciergeAuditPane />
      {/* ABOVE the tool rows, and outside the gated block on purpose. Everything below this asks
          "what may the concierge do on its own"; this asks "what does MY selection do", which is
          true whether or not the paid half is running. */}
      <section style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h3 style={groupHeading}>Copying</h3>
        <SettingCheckbox
          label="Copy on selection"
          checked={copyOnSelection}
          onToggle={() => setCopyOnSelection(!copyOnSelection)}
        />
        <p style={settingBlurb}>
          Highlight anything Sparkle said and it goes straight to your clipboard. The copy button
          under each answer works either way — and copies the original markdown, so tables and code
          blocks paste intact.
        </p>
      </section>
      {/* THE TUNER'S ONLY SWITCH. Without a row here the default-off flag is not "opt-in", it is
          unreachable — and an unreachable flag retires the whole §4e path (the classify command,
          its timeout, the argv/env hardening, the comparison log) into code that can never run and
          a tuning corpus that can never gain a row. Outside the gated block for the same reason as
          Copying above: it spends the user's OWN Claude subscription, not Sparkle credits, so it
          does not depend on the paid half being on. */}
      <section style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h3 style={groupHeading}>Dictation tuning</h3>
        <SettingCheckbox
          label="Help tune auto-send"
          checked={autoSendTuner}
          onToggle={() => setAutoSendTuner(!autoSendTuner)}
        />
        <p style={settingBlurb}>
          After each auto-send, grade the sentence with a background Haiku call and record it beside
          what the built-in heuristic guessed — the only way to find out when auto-send fired too
          early. It runs on your own Claude subscription rather than Sparkle credits, one call at a
          time, well after the message has gone. Off by default; auto-send itself works either way.
        </p>
      </section>
      {/* THE TAXONOMY, AND IT HAS FOUR AXES RATHER THAN THREE. "Irreversible, outward-facing, or
          metered" was the whole of it until the screenshot domain arrived, and every one of those
          three words is FALSE about a screen capture: it destroys nothing, publishes nothing and
          bills nothing — and it still asks, because of what it can SEE. A blurb that lists only the
          first three mis-describes the very default `privacy-sensitive` was minted to create, which
          is the one thing this box exists to get right. */}
      <div style={noticeBox}>
        Each tool is set on its own. Anything left on its default is decided by how risky it is —
        reading Sparkle’s own data and other reversible work happens silently, while anything
        irreversible, outward-facing, or metered
        {screenReadingClause(PRIVACY_TOOLS.length, "or that reads your screen")} stops to ask you
        first. Nothing defaults to “Never”.
      </div>
      <BulkBar
        gated={gated}
        ruleCount={ruleCount}
        onAllowAll={() => setPending("allow-all")}
        onResetAll={() => setPending("reset-all")}
      />
      {/* The gate check lives HERE and only here, unlike the rows — and the difference is real
          rather than an inconsistency. A row's buttons persist across the flip, so they need a
          `disabled` and a defensive re-read inside their handler. This dialog does not persist:
          the effect above drops `pending` and this guard unmounts it, so there is no rendered
          confirm button left holding a stale closure to defend. A `disabled={gated}` inside
          BulkConfirm would read as a second, independent guard while being statically dead — it
          could only ever see the same `gated === false` this line already tested. */}
      {pending && !gated && (
        <BulkConfirm
          action={pending}
          ruleCount={ruleCount}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            void (pending === "allow-all" ? allowAllConciergeTools() : resetAllConciergeTools());
            setPending(null);
          }}
        />
      )}
      {CONCIERGE_TOOL_GROUPS.map((group) => (
        <section
          key={group.domain}
          style={{ display: "flex", flexDirection: "column", gap: 12, opacity: gated ? 0.55 : 1 }}
        >
          <h3 style={groupHeading}>{group.label}</h3>
          {group.tools.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              evaluation={evaluateToolPolicy(tool.name, { overrides })}
              gated={gated}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/** The id the gated rows' controls point their `aria-describedby` at — so the reason a button is
 *  disabled is available on EVERY row without the sentence being repeated fifty times. */
const GATE_REASON_ID = "concierge-ai-gate-reason";

/** The two bulk gestures. There is no third, and there is deliberately no tiered variant of the
 *  first — see the header. */
type BulkAction = "allow-all" | "reset-all";

/** The tools whose risk class is the strongest word the vocabulary has. DERIVED from the catalog,
 *  never a hand-listed count: the confirmation's whole job is to name how many there really are,
 *  and a number typed here would go stale the first time a tool is reclassified. */
const IRREVERSIBLE_TOOLS = CONCIERGE_TOOL_CATALOG.filter((t) => t.riskClass === "irreversible");

/** Three irreversible tools to name in the confirmation, ONE PER DOMAIN.
 *
 *  Taking the first three in catalog order instead reads "discard_agent, delete_agent_branch,
 *  delete_agent_branch_if_merged" — three neighbours from one domain that sound like one thing, so
 *  the sentence understates its own range. One per domain says "agents, branches, AND your
 *  projects" in the same three words. Still derived: no name is typed here. */
const IRREVERSIBLE_EXAMPLES = IRREVERSIBLE_TOOLS.filter(
  (t, _i, all) => all.find((o) => o.domain === t.domain) === t,
).slice(0, 3);

/** The tools that read the HUMAN rather than the app — a screen capture. DERIVED from the catalog
 *  for the same reason the irreversible list is: the names ARE the sentence's content, and a
 *  hand-typed list goes stale the first time a tool is reclassified.
 *
 *  ITS OWN TIER IN THE CONFIRMATION, not folded into the irreversible clause, because the
 *  irreversible clause cannot carry it: "destroys something nothing here can put back" is simply
 *  untrue of a screenshot, so a reader who checked the claim would (correctly) conclude the sentence
 *  did not cover it. Until this existed, someone clicking through "Allow every concierge tool?" was
 *  also handing over unprompted photographs of their screen and was told nothing about it — the copy
 *  named the consequence axis and this class is the only one on the privacy axis. */
const PRIVACY_TOOLS = CONCIERGE_TOOL_CATALOG.filter((t) => t.riskClass === "privacy-sensitive");

/**
 * The screen-reading clause, or nothing when no tool is on the privacy axis.
 *
 * A FUNCTION OF A COUNT, taking the count as an argument rather than reading `PRIVACY_TOOLS`, and
 * that is the whole reason it exists (roborev 55526). Both call sites used to inline
 * `PRIVACY_TOOLS.length > 0 && "…"`, which made the false arm unreachable from a test: the class is
 * non-empty in the real catalog, so nothing could check that the sentence still READS correctly with
 * the clause dropped ("…or metered stops to ask you first"). Passing the count in makes both arms
 * directly assertable without contriving a catalog injection, and keeps one source for a string that
 * appeared in three places and had drifted in two of them.
 *
 * `phrasing` differs between the sites — the blurb says "or that reads your screen", the reset-all
 * confirmation "and anything that reads your screen" — so it stays a parameter; what must not differ
 * is WHETHER the clause appears at all.
 */
export function screenReadingClause(privacyCount: number, phrasing: string): string {
  return privacyCount > 0 ? ` — ${phrasing} —` : "";
}

/**
 * Set everything at once, in one place, above the rows it governs.
 *
 * "Reset all to defaults" is disabled when there are no rules to clear — a control that does
 * nothing is worse than one that isn't there, because pressing it teaches you it's broken. Both are
 * gated with the rows for the same reason the rows are: they write the same policy.
 */
function BulkBar({
  gated,
  ruleCount,
  onAllowAll,
  onResetAll,
}: {
  gated: boolean;
  ruleCount: number;
  onAllowAll: () => void;
  onResetAll: () => void;
}) {
  const nothingToReset = ruleCount === 0;
  return (
    <div style={bulkBar} data-testid="concierge-bulk-bar">
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={bulkTitle}>Everything at once</span>
        <span style={bulkBlurb}>
          Let the concierge run every tool without asking, or put them all back on their defaults.
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "none" }}>
        <button
          type="button"
          className={LINK_CLASS}
          style={linkBtn}
          disabled={gated || nothingToReset}
          title={nothingToReset ? "Every tool is already on its default." : undefined}
          aria-describedby={gated ? GATE_REASON_ID : undefined}
          onClick={() => {
            if (gated || nothingToReset) return;
            onResetAll();
          }}
        >
          Reset all to defaults
        </button>
        <button
          type="button"
          style={bulkPrimaryBtn(gated)}
          disabled={gated}
          aria-describedby={gated ? GATE_REASON_ID : undefined}
          onClick={() => {
            if (gated) return;
            onAllowAll();
          }}
        >
          Allow everything
        </button>
      </div>
    </div>
  );
}

/**
 * The one confirmation, for either bulk gesture.
 *
 * ALLOW-ALL NAMES THE IRREVERSIBLE COUNT because that is what the IRREVERSIBLE tag is for: the
 * point of classifying `remove_project` and `discard_agent` is that somebody is told before they
 * hand those over silently. It names a few of them too — a bare number is a statistic, and a
 * statistic is easier to click past than "removing a project".
 *
 * AND IT NAMES THE SCREEN-READING TOOLS SEPARATELY, on the same principle applied to the axis the
 * irreversible clause cannot reach. "Destroys something nothing here can put back" is false about a
 * screenshot, so that clause does not — and must not be read to — cover it. Granting everything
 * hands over unprompted captures of the user's screen; a confirmation that mentioned only
 * consequence-risk let that through in silence.
 *
 * RESET-ALL CONFIRMS TOO, and that is not the second variant the header rules out — it is the same
 * gesture's safety. It discards every rule the human wrote, which for someone who spent ten minutes
 * tuning this pane is the destructive one of the pair, whatever its reassuring name suggests.
 *
 * Takes NO `gated` prop, deliberately. The gate is the caller's to hold: this is only ever rendered
 * from a pass where enhancements are on, and it is unmounted (not just disabled) when they go off.
 * A `gated` prop here would be read from that same render's closure — always false — so it could
 * never be fresher than the check that mounted this, while reading like a second guard.
 */
function BulkConfirm({
  action,
  ruleCount,
  onCancel,
  onConfirm,
}: {
  action: BulkAction;
  ruleCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const allowAll = action === "allow-all";
  const examples = IRREVERSIBLE_EXAMPLES.map((t) => t.name).join(", ");
  // Named in full rather than counted: there are two of them, and "capture_window, capture_agent"
  // is both shorter and more informative than "2 screen-reading tools". Guarded on length so a
  // future reclassification that empties the class removes the sentence instead of rendering
  // "the 0 tools that".
  const privacyNames = PRIVACY_TOOLS.map((t) => t.name).join(", ");
  return (
    <ModalShell width={440} zIndex={120} onCancel={onCancel}>
      <div data-testid="concierge-bulk-confirm" role="alertdialog" aria-label="Confirm bulk change">
        <h2 style={confirmHeadline}>
          {allowAll ? "Allow every concierge tool?" : "Reset every tool to its default?"}
        </h2>
        <p style={confirmBody}>
          {allowAll ? (
            <>
              All {CONCIERGE_TOOL_CATALOG.length} tools will run silently, with no prompt. This
              includes {IRREVERSIBLE_TOOLS.length} irreversible tools — {examples} and others that
              destroy something nothing here can put back.
              {PRIVACY_TOOLS.length > 0 && (
                <>
                  {" "}
                  It also lets the concierge photograph your screen without asking ({privacyNames}).
                  Those destroy nothing — but a capture takes in whatever else is on screen at that
                  moment, not just Sparkle.
                </>
              )}
            </>
          ) : (
            <>
              This clears {ruleCount === 1 ? "the 1 rule" : `all ${ruleCount} rules`} you have set.
              Every tool goes back to the decision its risk class implies — reading Sparkle’s own
              data and routine work silently, everything irreversible, outward-facing or metered
              {screenReadingClause(PRIVACY_TOOLS.length, "and anything that reads your screen")}{" "}
              asking you first.
            </>
          )}
        </p>
        <p style={confirmFoot}>
          {allowAll
            ? "Undo it with “Reset all to defaults”, or change any single row afterwards."
            : "Each row can still be set individually afterwards."}
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" style={confirmCancelBtn} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" style={confirmGoBtn} onClick={onConfirm}>
            {allowAll ? "Allow everything" : "Reset all"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/**
 * The single banner. One headline, one sentence, one action — and the action is chosen by the
 * remedy, because there are three different reasons the concierge can be dark and telling a user
 * the wrong one is worse than telling them nothing:
 *
 *  • `enable-setting` — their own switch. Free and instant, so it gets a plain "Turn on".
 *  • `buy-app`        — the $99 has not been bought: the EXISTING AiLockedNotice paywall.
 *  • `top-up`         — bought, balance spent: the EXISTING refill seam. Deliberately NOT the $99
 *                       upsell — this user already owns the app.
 *
 * The ✦ and the brand gradient are the marketing badge's own (AI_ENHANCEMENTS_GRADIENT is imported
 * rather than re-declared). The badge COMPONENT isn't reused verbatim: it says "Sparkle + AI
 * enhancements" at 18px marketing scale, and this is a settings banner making a different sentence.
 */
function AiEnhancementsGate({ remedy }: { remedy: ConciergeAiRemedy }) {
  return (
    <div style={gateBox} role="note" data-testid="concierge-ai-gate">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ color: C.accent, fontSize: TYPE.body, lineHeight: 1 }}>
          ✦
        </span>
        <span style={gateHeadline}>Requires AI enhancements</span>
      </div>
      <p id={GATE_REASON_ID} style={gateBody}>
        Turn them on to let your concierge act — and to tune it per tool.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10 }}>
        {remedy === "buy-app" ? (
          <AiLockedNotice
            label="Buy Sparkle to let your concierge act."
            style={{ background: "transparent", border: "none", padding: 0 }}
          />
        ) : remedy === "top-up" ? (
          <RefillLink label="Add credits" />
        ) : (
          <button type="button" style={turnOnBtn} onClick={turnOnConciergeAi}>
            Turn on
          </button>
        )}
      </div>
      <p style={gateFoot}>
        Your per-tool rules below are saved — turning enhancements back on restores them.
      </p>
    </div>
  );
}

/** One tool: what it does, how risky it is, where its current value came from, and the control.
 *
 *  `gated` greys the row and makes it READ-ONLY. It changes nothing else: the name, the risk, the
 *  "set by you" pill and the highlighted value are all still the truth about their configuration,
 *  which is both the point of showing the row and the promise that nothing was reset. */
function ToolRow({
  tool,
  evaluation,
  gated,
}: {
  tool: ConciergeToolEntry;
  evaluation: ToolPolicyEvaluation;
  gated: boolean;
}) {
  // An entry that isn't allow/ask/deny (a hand-edit typo) resolves to "ask" WITHOUT matching any
  // button — so highlight nothing and say why, rather than showing a value the file doesn't hold.
  const unreadable = evaluation.source === "unreadable-override";
  const selected: PolicyDecision | null = unreadable ? null : evaluation.decision;

  return (
    <div style={row} data-testid="concierge-tool-row">
      {/* The one column that MAY wrap, and the only one that flexes. `minWidth: 0` is what lets it
          actually give ground — without it a flex item refuses to shrink below its content and the
          control column gets squeezed instead, which is how the segment wrapped. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: "1 1 auto", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
          <span style={toolName}>{tool.name}</span>
          <span style={riskPill} title={`Risk: ${tool.riskClass}`}>
            {tool.riskClass}
          </span>
          {evaluation.overridden ? (
            <span style={setByYouPill}>set by you</span>
          ) : (
            <span style={defaultPill}>default</span>
          )}
          {unreadable && (
            <span style={warnPill} title={evaluation.reason}>
              <FiAlertTriangle size={11} /> unreadable
            </span>
          )}
        </div>
        <span style={{ color: C.muted, fontSize: 12, lineHeight: 1.45 }}>{tool.summary}</span>
        <span style={{ color: unreadable ? C.amber : C.muted, fontSize: 12 }}>
          {statusText(tool, evaluation)}
        </span>
      </div>
      {/* The read-only marker: one glyph, no words. The sentence lives in the banner, and the
          buttons' aria-describedby already points every screen reader at it.

          OUTSIDE the fixed control column on purpose — inside it, it would eat the Reset slot on
          every gated row and shift the segment, which is the alignment bug this layout exists to
          kill. Out here it only narrows the description, which is allowed to flex. */}
      {gated && (
        <span
          data-testid="concierge-tool-readonly"
          aria-hidden
          style={{ color: C.muted, display: "inline-flex", alignItems: "center", flex: "none" }}
        >
          <FiSlash size={12} />
        </span>
      )}
      <div style={controlCell} data-testid="concierge-tool-control">
        {/* Reserved whether or not this row has a Reset, so every segment starts at the same x. */}
        <div style={resetSlot}>
          {evaluation.overridden && (
            <button
              type="button"
              className={LINK_CLASS}
              aria-label={`Reset ${tool.name} to its default`}
              title={`Back to the default: ${POLICY_DECISION_LABEL[tool.defaultDecision ?? "ask"]}`}
              disabled={gated}
              aria-describedby={gated ? GATE_REASON_ID : undefined}
              style={linkBtn}
              onClick={() => {
                if (gated) return;
                void setConciergeToolPolicy(tool.name, null);
              }}
            >
              Reset
            </button>
          )}
        </div>
        <div
          style={segment}
          data-testid="concierge-tool-segment"
          role="group"
          aria-label={`${tool.name} permission`}
        >
          {POLICY_DECISIONS.map((decision, i) => (
            <button
              key={decision}
              type="button"
              aria-pressed={selected === decision}
              disabled={gated}
              aria-describedby={gated ? GATE_REASON_ID : undefined}
              style={segmentBtn(selected === decision, i === 0, gated)}
              // Belt and braces with `disabled`: a write while the concierge cannot act is not a
              // write we want to make, and the rules on this pane are the user's own.
              onClick={() => {
                if (gated) return;
                void setConciergeToolPolicy(tool.name, decision);
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

/** The one line under a row: what happens now, and — when the user has set it — what the default
 *  was, so reverting is an informed choice rather than a guess. */
function statusText(tool: ConciergeToolEntry, evaluation: ToolPolicyEvaluation): string {
  if (evaluation.source === "unreadable-override") {
    return "config.toml holds a value that isn't allow, ask, or deny — asking first until it's fixed.";
  }
  const now =
    evaluation.decision === "allow"
      ? "Runs without asking"
      : evaluation.decision === "ask"
        ? "Asks you first, every time"
        : "Never runs";
  if (!evaluation.overridden) {
    return `${now} — the default for ${tool.riskClass} tools.`;
  }
  return `${now}. Default: ${POLICY_DECISION_LABEL[tool.defaultDecision ?? "ask"]}.`;
}

/** Exported for the ⋯-dialog rail's keyword set, so the rail advertises the same words the pane
 *  actually contains rather than an approximation someone maintains by hand. */
export const CONCIERGE_TOOLS_SEARCH_TERMS: readonly string[] = [
  "auto-send",
  "dictation tuning",
  "tune auto-send",
  "haiku",
  "concierge autonomy per-tool permission allow ask deny approve silently risk irreversible",
  // The screen-reading tier, searched for by what it is rather than by its class name — "privacy"
  // and "screenshot" are what someone types when they want to know whether it can see their screen.
  "screenshot screen capture privacy reads your screen",
  // The copy affordances (PRD 1). Searched for by what people call it, not by the label alone —
  // "clipboard" and "select" are what someone types when they can't find the switch.
  "copy on selection clipboard copying select highlight copy answer markdown paste",
  // The audit log. Searched for by the QUESTION rather than the feature name — nobody types "audit
  // log" when what they want to know is why the concierge didn't do the thing they asked.
  "audit log history what did it just do recent calls refused denied why didn't it",
  ...CONCIERGE_TOOL_GROUPS.map((g) => `${g.label} ${g.tools.map((t) => t.name).join(" ")}`),
];

// --- styles (matched to the surrounding Settings panes; see ApprovalsMenu) --------------------

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  // NOT `wrap`: the description flexes and the control column is fixed, so there is nothing left to
  // wrap — and allowing it would let a long summary drop the controls onto their own line, which is
  // the same visual failure this layout removes, one level up.
  flexWrap: "nowrap",
  gap: 12,
  paddingBottom: 12,
  borderBottom: `1px solid ${C.hairline}`,
};

const groupHeading: CSSProperties = { ...SECTION_LABEL, margin: 0 };

/** The sentence under a checkbox row — same muted 12px the tool rows' summaries use. */
const settingBlurb: CSSProperties = {
  margin: "0 0 0 28px",
  fontSize: TYPE.small,
  lineHeight: 1.45,
  color: C.muted,
};

const toolName: CSSProperties = {
  color: C.cream,
  fontWeight: FONT_WEIGHT.semibold,
  fontSize: 13,
  fontFamily: FONT_MONO,
  // A backstop, not the plan. The description column is sized to fit the longest name on one line
  // (see CONTROL_W), but a tool name is a single unbreakable word and a wider font on some platform
  // would otherwise push it out of the row rather than wrap it. Breaking mid-name is ugly; silently
  // overflowing into the controls is worse.
  overflowWrap: "anywhere",
};

// An inset well inside the SettingsDialog shell — same treatment (and same reasoning about which
// token carries the boundary) as ApprovalsMenu's notice.
const noticeBox: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  lineHeight: 1.5,
  background: C.forest,
  border: `1px solid ${C.hairline}`,
  borderRadius: 6,
  padding: "8px 10px",
};

// The gate banner. Same inset-well geometry as `noticeBox` so it sits in the pane's rhythm, but the
// 1.5px stroke carries the brand gradient (the badge's double-background trick: a padding-box fill
// over a border-box gradient) — it is the app's mark for "this is an AI enhancement".
const gateBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  background: `linear-gradient(${C.forest}, ${C.forest}) padding-box, ${AI_ENHANCEMENTS_GRADIENT} border-box`,
  border: "1.5px solid transparent",
  borderRadius: 6,
  padding: "10px 12px",
};

const gateHeadline: CSSProperties = {
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  background: AI_ENHANCEMENTS_GRADIENT,
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

const gateBody: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: C.cream,
};

const gateFoot: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.45,
  color: C.muted,
};

const turnOnBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 4,
  padding: "4px 12px",
  fontSize: 12,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: FONT_UI,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function pill(color: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    ...tag(color),
    gap: 3,
  };
}

const riskPill = pill(C.muted);
const defaultPill = pill(C.muted);
const setByYouPill = pill(C.teal);
const warnPill = pill(C.amber);

// --- the control column ------------------------------------------------------------------------
//
// Three numbers, and every one of them is load-bearing rather than taste. The pane's content box is
// ~490px inside the 720px settings dialog; the segment's natural width (three 12px labels, the
// widest being "Ask first") measures ~143px, and "Reset" measures ~34px. So the column reserves
// 170 + 6 + 38 = 214px and hands the remaining ~264px to the description — enough for the longest
// tool name (`append_communication_guideline`, ~234px at 13px monospace) to sit on one line.
//
// EVERY PIXEL HERE IS TAKEN FROM THE DESCRIPTION, which is why these are as tight as they are and
// not merely round. A fixed control column trades horizontal room for alignment, and the
// description pays: measured in the running app, widening this column past its need re-wraps ~62
// summaries and grows the pane's scroll height by a quarter. Reserve what the controls need, not
// what looks comfortable in the source.
//
// SEGMENT_W still keeps ~27px of slack over that natural measurement, deliberately: the labels
// render in the platform UI font, so their exact width is not ours to know, and the buttons grow
// into the slack rather than shrinking out of it (`flex: "1 1 auto"` over a fixed-width, nowrap
// parent) — the failure mode of guessing low is clipped text, which is worse than a wide column.

/** The three-option segmented control's reserved width. */
const SEGMENT_W = 170;
/** The Reset link's reserved slot — held open on rows that have no Reset, so the segment does not
 *  slide sideways from row to row. */
const RESET_W = 38;
/** Gap between the two, inside the control column. */
const CONTROL_GAP = 6;
/** What every row reserves for its controls, whatever its labels, badges, or Reset say. */
const CONTROL_W = RESET_W + CONTROL_GAP + SEGMENT_W;

const controlCell: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: CONTROL_GAP,
  // Fixed basis, and no shrinking: this column's width is the promise the whole layout makes.
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
  // THE requirement: the three options are one control and never break across lines.
  flexWrap: "nowrap",
  flex: `0 0 ${SEGMENT_W}px`,
  width: SEGMENT_W,
  border: `1px solid ${C.muted}`,
  borderRadius: RADIUS.input,
  // Clips the child buttons' corners to the group's radius — what makes three buttons read as one
  // control rather than three that happen to touch.
  overflow: "hidden",
};

/** One option inside the segment. Joined to its neighbours by a single shared rule rather than each
 *  carrying its own box — the active fill then reads as a selection within one control. */
function segmentBtn(active: boolean, first: boolean, gated: boolean): CSSProperties {
  return {
    flex: "1 1 auto",
    minWidth: 0,
    background: active ? C.teal : "transparent",
    // Text ON a brand-teal fill: the token for exactly that, which stays light in BOTH themes.
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

/** The class that carries the hover state inline styles cannot express (index.css). Shared by the
 *  per-row Reset and the pane's "Reset all to defaults" so the two read as the same kind of thing. */
const LINK_CLASS = "settings-link-btn";

/** A text link that happens to perform an action: no border, no fill, muted until hover. Stays a
 *  <button> element — it does something, so an <a> would be a lie to assistive tech. */
const linkBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  fontSize: 12,
  fontFamily: FONT_UI,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// --- the bulk bar ------------------------------------------------------------------------------

const bulkBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
  background: C.forest,
  border: `1px solid ${C.hairline}`,
  borderRadius: 6,
  padding: "10px 12px",
};

const bulkTitle: CSSProperties = {
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  color: C.cream,
};

const bulkBlurb: CSSProperties = { fontSize: 12, lineHeight: 1.45, color: C.muted };

const bulkPrimaryBtn = (gated: boolean): CSSProperties => ({
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: RADIUS.input,
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: FONT_UI,
  cursor: gated ? "default" : "pointer",
  whiteSpace: "nowrap",
  opacity: gated ? 0.6 : 1,
});

// --- the confirmation --------------------------------------------------------------------------

const confirmHeadline: CSSProperties = {
  margin: "0 0 10px",
  // A dialog title, which is exactly what the scale's ceiling is for — not a hand-picked 16.
  fontSize: TYPE.title,
  fontWeight: FONT_WEIGHT.semibold,
  color: C.cream,
};

const confirmBody: CSSProperties = { margin: "0 0 8px", fontSize: 13, lineHeight: 1.6, color: C.cream };

const confirmFoot: CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5, color: C.muted };

const confirmCancelBtn: CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.hairline}`,
  color: C.muted,
  borderRadius: RADIUS.input,
  padding: "8px 16px",
  fontSize: 13,
  fontFamily: FONT_UI,
  cursor: "pointer",
};

const confirmGoBtn: CSSProperties = {
  background: C.teal,
  border: "none",
  color: ON_BRAND_FILL,
  borderRadius: RADIUS.input,
  padding: "8px 18px",
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: FONT_UI,
  cursor: "pointer",
};
