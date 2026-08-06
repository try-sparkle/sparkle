// THE TWO WAYS TO CREATE AN AGENT — "+ Local Agent" and "+ Cloud Agent".
//
// Founder, 2026-08-04: "I want to be able to spin up a new local build agent OR a new cloud agent.
// Where it currently says 'New Build Agent' there should be TWO options: '+ Local Agent' and
// '+ Cloud Agent'."
//
// WHAT THIS REPLACED, and why the shape changed. There used to be ONE dashed row ("+ New Build
// Agent") whose runtime was decided by a separate Local/Cloud radio toggle above it
// (NewAgentRuntimeToggle, deleted with this change). That design had two defects the founder named:
//
//   1. The toggle RENDERED NOTHING unless the server had advertised the cloud capability, so on a
//      local-only account there was no cloud surface at all — not even a hint the feature exists.
//      That is sparkle-lcx8y exactly: a control that vanishes on scope teaches the user the feature
//      was DELETED. The cloud button below is therefore ALWAYS rendered, and when it cannot be used
//      it is disabled with the REAL reason underneath it (services/cloudAgents/gating.ts enumerates
//      them: feature off / signed out / unpaid / no Claude auth / no credits).
//   2. Creating a cloud agent took two gestures in two different controls, with the armed runtime
//      only visible as a highlighted radio. A billed action should be its own button.
//
// The cost asymmetry is why the cloud row never becomes the default and never auto-arms: a local
// agent is a free PTY on this Mac, a cloud agent bills credits per running minute.

import { useEffect, useState, type CSSProperties } from "react";
import { FiCloud, FiTool } from "react-icons/fi";

import { C } from "../theme/colors";
import { FONT_UI, TYPE } from "../theme/scale";
import { FONT_WEIGHT } from "@sparkle/ui";
import { BUILD_INK } from "./PlanBuildToggle";
import { NEW_BUILD_AGENT_DND_TARGET } from "../services/dndTargets";
import { useCloudGate } from "../hooks/useCloudAgents";
import { openSignIn } from "../services/sparkleApi";
import { useUiStore } from "../stores/uiStore";
import type { CloudGate } from "../services/cloudAgents/gating";
import type { CategoryId } from "../stores/uiStore";

// A dashed-outline "+ <kind> Agent" row — the affordance for creating an agent, shown in the
// sidebar list for the active Build mode: below the last row when the list fits, or pinned (sticky)
// at the top when the list is tall enough to scroll.
// Border is split into longhand props (width/style/color) so NewAgentRow's hover state can flip
// just the style (dashed → solid) and color without fighting a `border` shorthand.
const DASHED_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  margin: "2px 0 8px",
  padding: "9px 10px",
  borderWidth: 1,
  borderStyle: "dashed",
  borderColor: C.muted,
  borderRadius: 6,
  background: "transparent",
  color: C.muted,
  fontFamily: FONT_UI,
  fontSize: TYPE.body,
  fontWeight: FONT_WEIGHT.semibold,
  cursor: "pointer",
};

// On hover the dotted outline becomes a solid stroke and the icon + label light up in the mode's
// accent — the same gold as that mode's chevron. It takes the INK twin of that gold (`BUILD_INK`),
// not the chevron's fill: `hoverColor` lands on `color` and `borderColor` here, and a fill token is
// only held to the 3:1 control floor — see the note on PlanBuildToggle.BUILD_INK. The background is
// left unchanged.
// `sharedHover`/`onHoverChange` let a SECOND instance of the button elsewhere (the Workspace
// empty-state start button) drive this one lit too, so hovering either lights up both.
function NewAgentRow({
  icon,
  label,
  hoverColor,
  onClick,
  sharedHover,
  onHoverChange,
  dndTarget,
  dataHint,
  disabled,
  title,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  hoverColor: string;
  onClick: () => void;
  sharedHover?: boolean;
  onHoverChange?: (v: boolean) => void;
  // Marks the button as a webview drag-drop target (see services/dndTargets.ts) so the
  // window-global drag handlers can hit-test the cursor against it with elementFromPoint.
  dndTarget?: string;
  // Registers the button in the keyboard-hint overlay (see keyboardHints/hintTargets.ts). Only the
  // sidebar instance passes this — the Workspace empty-state copy leaves it undefined so a single
  // chiclet shows even when both buttons are on screen at once.
  dataHint?: string;
  // A disabled row still RENDERS (that is the whole point — see the header): it just cannot be
  // pressed, keeps the muted ink, and never lights on hover.
  disabled?: boolean;
  title?: string;
  testId?: string;
}) {
  const [hover, setHover] = useState(false);
  const lit = !disabled && (hover || !!sharedHover);
  return (
    <button
      type="button"
      data-testid={testId}
      data-dnd-target={dndTarget}
      data-hint={dataHint}
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => {
        setHover(true);
        onHoverChange?.(true);
      }}
      onMouseLeave={() => {
        setHover(false);
        onHoverChange?.(false);
      }}
      style={{
        ...DASHED_ROW_STYLE,
        borderStyle: lit ? "solid" : "dashed",
        borderColor: lit ? hoverColor : C.muted,
        color: lit ? hoverColor : C.muted,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// The LOCAL row, wired to the shared `buildAgentHover` flag so every instance (the sidebar's row
// AND the Workspace empty-state start button) highlights in sync. Also a drag-drop target: dropping
// files on it spawns a new local build agent with the files attached to ITS composer
// (useNewBuildAgentDrop), which lights buildAgentHover during the drag — so the drag-over visual IS
// the normal hover visual, on both copies.
function NewLocalAgentButton({ onClick, dataHint }: { onClick: () => void; dataHint?: string }) {
  const buildAgentHover = useUiStore((s) => s.buildAgentHover);
  const setBuildAgentHover = useUiStore((s) => s.setBuildAgentHover);
  // Clear the shared flag if this button unmounts while hovered — clicking the empty-state instance
  // spawns an agent, which unmounts it before onMouseLeave can fire, otherwise leaving the sidebar's
  // copy stuck lit. Any still-hovered sibling re-lights itself via its own local hover state.
  useEffect(() => () => setBuildAgentHover(false), [setBuildAgentHover]);
  return (
    <NewAgentRow
      // A react-icon, not the ⚒ character it replaced — the same swap PlanBuildToggle's Build
      // chevron made, and for the second reason stated there as well as the emoji ban: an
      // emoji-font glyph ignores `color`, so the ⚒ could not follow the gold hover ink.
      icon={<FiTool size={18} style={{ flexShrink: 0 }} />}
      label="+ Local Agent"
      title="Run the agent on this Mac (free)"
      hoverColor={BUILD_INK}
      onClick={onClick}
      sharedHover={buildAgentHover}
      onHoverChange={setBuildAgentHover}
      dndTarget={NEW_BUILD_AGENT_DND_TARGET}
      dataHint={dataHint}
      testId="new-local-agent"
    />
  );
}

// The CLOUD row. ALWAYS RENDERED — see the header. It opens NewCloudAgentDialog (mounted once by
// the Workspace, keyed off `uiStore.cloudCreateProjectId`), which re-checks the same gate server-side
// before anything bills.
//
// Deliberately NOT a drag-drop target and NOT part of `buildAgentHover`: dropping files arms a
// local composer, and a shared hover flag across a free row and a billed one would make the two
// look like one control again.
function NewCloudAgentButton({ projectId, dataHint }: { projectId: string | null; dataHint?: string }) {
  const gate = useCloudGate();
  const setCloudCreateProjectId = useUiStore((s) => s.setCloudCreateProjectId);
  const openSettings = useUiStore((s) => s.openSettings);
  const blocked = gate.ok ? null : gate;
  return (
    <>
      <NewAgentRow
        icon={<FiCloud size={18} style={{ flexShrink: 0 }} />}
        label="+ Cloud Agent"
        title={
          blocked
            ? blocked.message
            : "Run the agent in a Sparkle sandbox — keeps going with Sparkle closed. Billed in credits per running minute."
        }
        hoverColor={C.teal}
        // The project is captured HERE, from the column this row belongs to — not read live by
        // the singleton dialog, which would answer to whichever tab is in front when it renders.
        onClick={() => setCloudCreateProjectId(projectId)}
        // `disabled` is the ONE thing standing between a blocked account and the billed dialog —
        // there is deliberately no second in-handler guard, because a guard nothing can reach is a
        // guard no test can pin (dropping it changed no assertion; dropping this attribute fails
        // three). The dialog re-runs the same gate, and POST /sessions/start is the definitive
        // server-side check, so this is the outermost of three, not the only one.
        disabled={!gate.ok || projectId === null}
        dataHint={dataHint}
        testId="new-cloud-agent"
      />
      {blocked && <BlockReason blocked={blocked} openSettings={openSettings} />}
    </>
  );
}

/**
 * THE REASON, IN THE COLUMN — not only in a tooltip nobody hovers, and where possible it is also
 * the way OUT.
 *
 * The gate names TWO different kinds of self-serve fix and they are not interchangeable
 * (`services/cloudAgents/gating.ts`): `deepLink` points at a Settings section, while `needsSignIn`
 * means "the creation UI offers the sign-in hand-off, not Settings" — `signed_out` carries the flag
 * and NO deep link. Handling only `deepLink` therefore left the single most common blocked state,
 * a signed-out user, as inert copy next to a disabled button: a complete dead end, and a direct
 * contradiction of this component's own claim to be the way out. Both dialogs that render this gate
 * (`NewCloudAgentDialog`, `CreditsPanel`) offer sign-in for exactly this case; so does this row.
 *
 * There is no longer any block with NEITHER. `feature_disabled` was the one, and it was deleted
 * along with the flag it read — so `act` is non-null for every reason the gate can now return, and
 * `gating.test.ts` fails if that ever stops being true. The null branch below is kept as a
 * defensive render, not as a state anyone should be able to reach.
 */
function BlockReason({
  blocked,
  openSettings,
}: {
  blocked: Extract<CloudGate, { ok: false }>;
  openSettings: (cat: CategoryId) => void;
}) {
  const act = blocked.needsSignIn
    ? () => void openSignIn()
    : blocked.deepLink
      ? () => openSettings(blocked.deepLink!)
      : null;
  return (
    <div
      data-testid="new-cloud-agent-reason"
      role={act ? "button" : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={() => act?.()}
      onKeyDown={(e) => {
        if (act && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          act();
        }
      }}
      style={{
        ...reasonStyle,
        cursor: act ? "pointer" : "default",
        textDecoration: act ? "underline" : "none",
      }}
    >
      {blocked.message}
    </div>
  );
}

/**
 * BOTH create affordances, stacked, in the order local-then-cloud.
 *
 * Local leads deliberately and permanently: it is the free one. The two places that offer agent
 * creation (the sidebar's list slot and the Workspace empty state) both render THIS, so they cannot
 * drift apart the way the old single-button-plus-toggle pair did.
 *
 * A fragment, not a wrapper element: both placement slots are already flex columns and assert on
 * the button's parent (AgentSidebar.newAgentPlacement.test.tsx), so these rows must stay THEIR
 * direct children.
 */
export function NewAgentButtons({
  onLocalClick,
  projectId,
  dataHint,
}: {
  onLocalClick: () => void;
  /** The project THIS pair of rows belongs to. Captured on a cloud click so the singleton dialog
   *  creates where the user clicked rather than in whatever tab is in front. */
  projectId: string | null;
  dataHint?: boolean;
}) {
  return (
    <>
      <NewLocalAgentButton onClick={onLocalClick} dataHint={dataHint ? "newbuild" : undefined} />
      <NewCloudAgentButton projectId={projectId} dataHint={dataHint ? "newcloud" : undefined} />
    </>
  );
}

const reasonStyle: CSSProperties = {
  margin: "-4px 0 8px",
  padding: "0 2px",
  fontFamily: FONT_UI,
  fontSize: TYPE.small,
  lineHeight: 1.35,
  color: C.muted,
};
