import { useState, useEffect, useMemo, type CSSProperties } from "react";
import { C, AGENT_STATUS, FONT_WEIGHT, ON_BRAND_FILL, statusInk } from "../theme/colors";
import type { AgentTabStatus, Project } from "../types";
import { SettingsDialog } from "./SettingsDialog";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { withUnstartedWorkerAttention } from "../engine/workerAttention";
import { withDismissedAlerts } from "../engine/alertDismissal";
import { pickProjectFolder, basename } from "../services/dialog";
import { openProjectInWindow, defaultDeps, type OpenMode } from "../services/projectWindows";
import { findWindowForProject } from "../services/windowRegistry";
import { resolveOpenTarget, type OpenTarget } from "../services/openTarget";
import { OpenTargetDialog } from "./OpenTargetDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { ModalShell } from "./ModalShell";
import { AccountsScreen } from "./AccountsScreen";
import { AccountLoginModal } from "./AccountLoginModal";
import { AuthStatusButton } from "./AuthStatusButton";
import { invalidateAccountState } from "../services/accountSelection";
import type { Account } from "../services/accountStore";
import {
  useCurrentProjectId,
  useReplaceCurrentProject,
  useCurrentWindowLabel,
} from "../windowContext";
import { StatusDot } from "./StatusDot";
import { RECENT_HINT, RECENT_SWITCH_HINT } from "../keyboardHints/hintTargets";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";
import { deriveAuthView } from "../services/entitlement";
import { performTrialUnlock } from "../services/trialUnlock";
import { TrialIndicator } from "./TrialChrome";
import { OpenPrMenu, agentLinkForBranch, type PrAgentLink } from "./OpenPrMenu";

/** Most common status across a project's agents — drives the project's color (spec). */
function majorityStatus(
  project: Project,
  statusMap: Record<string, AgentTabStatus>,
): AgentTabStatus {
  if (project.agents.length === 0) return "stopped";
  const counts = new Map<AgentTabStatus, number>();
  for (const a of project.agents) {
    const st = statusMap[a.id] ?? "stopped";
    counts.set(st, (counts.get(st) ?? 0) + 1);
  }
  let best: AgentTabStatus = "stopped";
  let bestN = -1;
  for (const [st, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = st;
    }
  }
  return best;
}

const btn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  whiteSpace: "nowrap",
};

/**
 * Top bar: the current project (name colored by the majority of its agents' statuses, with
 * a per-agent dot cluster, click to open settings) plus the Recent / Open project
 * actions on the same row (Open covers both opening an existing folder and creating/cloning a new one).
 */
export function TopBar({ onOpenSettings }: { onOpenSettings: (p: Project) => void }) {
  // Trial counter + Unlock, shown in-row (left of the action cluster) only while in trial mode.
  // We derive the view here rather than threading a prop down from AuthGate through Workspace, and
  // route Unlock through the SAME shared paywall handler AuthGate's upsell uses (performTrialUnlock),
  // so a signed-in user converts via one-click Stripe — never bare sign-in. Only the placement of
  // the counter moved out of the covering pill; the unlock behavior is unchanged.
  const authLoading = useAuthStore((s) => s.loading);
  const tokenPresent = useAuthStore((s) => s.tokenPresent);
  const me = useAuthStore((s) => s.me);
  const paywallDismissed = useAuthStore((s) => s.paywallDismissed);
  const trialStarted = useTrialStore((s) => s.started);
  const trialLoading = useTrialStore((s) => s.loading);
  const inTrial =
    deriveAuthView({
      loading: authLoading,
      hasToken: tokenPresent,
      me,
      trialStarted,
      trialLoading,
      paywallDismissed,
    }) === "trial";
  const [trialFailedUrl, setTrialFailedUrl] = useState<string | null>(null);
  const onTrialUnlock = () => void performTrialUnlock(tokenPresent, setTrialFailedUrl);

  const projects = useProjectStore((s) => s.projects);
  const addProject = useProjectStore((s) => s.addProject);
  const touchProjectOpened = useProjectStore((s) => s.touchProjectOpened);
  const currentProjectId = useCurrentProjectId();
  const replaceCurrent = useReplaceCurrentProject();
  const windowLabel = useCurrentWindowLabel();
  const statusMap = useRuntimeStore((s) => s.status);
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  // A spawned-but-never-started worker has no live status, so it would render GRAY and hide the
  // fact that it's blocking its orchestrator. Overlay RED on it and its parent before computing any
  // dot/summary color, so the block surfaces at the top. Per-project (openAgentIds is global).
  const openSet = useMemo(() => new Set(openAgentIds), [openAgentIds]);
  // The dot cluster tracks the sidebar rows. It shares the unstarted-worker red overlay and the
  // dismissed-alert de-escalation (withDismissedAlerts) with the sidebar, so dismissing an alert drops
  // the row out of the red zone in BOTH places in lockstep, and its dot recolors with it. ONE
  // deliberate gap: the sidebar's status pipeline also bubbles a *started* worker's red up to its
  // orchestrator via withRedWorkerAttention (AgentSidebar.tsx), which is NOT applied here — so a
  // worker-bubbled orchestrator dot can still order/color differently. That divergence is pre-existing
  // (predates dismissals) and out of scope for this overlay.
  const effStatus = (p: Project): Record<string, AgentTabStatus> =>
    withDismissedAlerts(p.agents, withUnstartedWorkerAttention(p.agents, statusMap, openSet));
  const [recentOpen, setRecentOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The unified "Open a Project" dialog (folder / GitHub tabs). The single "Open" button opens this;
  // its "From folder" tab runs the same picker flow the old standalone "Open" button did, and its
  // "From GitHub" tab clones. "Recent" is unchanged.
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // The "Open" button reveals its full intent on hover ("Open (or Create) a Project Folder").
  const [openHover, setOpenHover] = useState(false);
  // Deep-open: other components (e.g. BalanceBadge → Credits) request a settings category via
  // uiStore.openSettings; this TopBar owns the dialog, so it opens it there. Every close path
  // clears the request so a later request for the SAME category still re-triggers.
  const settingsRequest = useUiStore((s) => s.settingsRequest);
  const clearSettingsRequest = useUiStore((s) => s.clearSettingsRequest);
  useEffect(() => {
    if (settingsRequest) setMenuOpen(true);
  }, [settingsRequest]);
  const closeMenu = () => {
    setMenuOpen(false);
    clearSettingsRequest();
  };
  // The settings modal is a true centered dialog now, so Escape should dismiss it (backdrop click
  // alone isn't enough for keyboard users). Only listen while it's open.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // closeMenu is stable in behavior (setState + store action); re-binding on menuOpen alone is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);
  // Multi Claude Max account support: the "Claude accounts" settings modal, and (when the user adds
  // an account) the interactive `claude login` modal handed off from AccountsScreen's onLogin seam.
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [loginAccount, setLoginAccount] = useState<Account | null>(null);
  // A pending replace/new-window choice (null = dialog closed). Two shapes:
  //   - "target": the folder is already known (Recent) — the choice just routes it.
  //   - "pick":  Open/New — we must ask the choice FIRST, then pop the folder picker. Showing the
  //     picker before this dialog is the regression we guard against: the user would hit the OS
  //     finder before ever being asked replace-vs-new-window.
  // A "new" target carries a not-yet-created folder so we only persist the project once the user
  // actually commits — cancelling the dialog must not leave an orphan project in Recent.
  const [pending, setPending] = useState<
    { type: "target"; target: OpenTarget } | { type: "pick"; title: string } | null
  >(null);

  const project = projects.find((p) => p.id === currentProjectId) ?? null;
  // The current project's dot, label, and cluster all read this — compute the overlay once instead
  // of re-spreading the status map on each call (the recent-project rows use effStatus directly; they
  // only render while the menu is open).
  const currentEff = useMemo(
    () => (project ? effStatus(project) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, statusMap, openSet],
  );

  // "Open agent" from a PR row: the pure branch→agent join (agentLinkForBranch) resolves the live
  // agent that opened a PR, falling back to null — the common case, since PRs outlive their agents,
  // and the menu then shows only the GitHub link.
  const resolveAgentForPr = (branch: string): PrAgentLink | null =>
    agentLinkForBranch(branch, projects, currentProjectId);

  const openAgentForPr = (link: PrAgentLink) => {
    if (link.isCurrentProject) {
      // Same window: mount its pane + select it, the same landing a jump-to-agent deep link performs.
      useRuntimeStore.getState().open(link.agentId);
      useProjectStore.getState().selectAgent(link.projectId, link.agentId);
    } else {
      // Another project: focus (or open) that project's window, deep-linked to the agent.
      void openProjectInWindow(
        link.projectId,
        "new",
        defaultDeps(replaceCurrent, touchProjectOpened, windowLabel),
        link.agentId,
      );
    }
  };
  // Recent first (most recently opened), so the "Recent Projects" label is honest.
  const recent = [...projects].sort((a, b) =>
    (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt),
  );

  const route = (projectId: string, mode: OpenMode) =>
    void openProjectInWindow(
      projectId,
      mode,
      defaultDeps(replaceCurrent, touchProjectOpened, windowLabel),
    );

  // Resolve a pending target to a concrete project id (creating it only now, on commit) and open.
  const resolveAndRoute = (p: OpenTarget, mode: OpenMode) => {
    const id = p.kind === "existing" ? p.id : addProject(p.name, p.path);
    route(id, mode);
  };

  // No project open in this window → skip the prompt and just take over the window.
  const openOrAsk = (target: OpenTarget) => {
    if (!currentProjectId) resolveAndRoute(target, "replace");
    else setPending({ type: "target", target });
  };

  // Pop the native folder picker, then open with the already-chosen mode. Map the folder to an
  // existing project (reuse) or a not-yet-created one — created only on commit, so a cancel adds
  // nothing.
  const pickAndRoute = async (title: string, mode: OpenMode) => {
    const picked = await pickProjectFolder(title);
    if (!picked) return;
    resolveAndRoute(resolveOpenTarget(picked, projects, basename), mode);
  };

  // Open / New entry point: ask replace-vs-new-window BEFORE the folder picker when a project is
  // already open (the picker is the LAST step, not the first). With no project open there's no
  // choice to make — go straight to the picker and take over the window.
  const startOpen = (title: string) => {
    setRecentOpen(false);
    if (!currentProjectId) void pickAndRoute(title, "replace");
    else setPending({ type: "pick", title });
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        background: C.barSurface,
        borderBottom: `1px solid ${C.forest}`,
        minHeight: 30,
        position: "relative",
      }}
    >
      {project ? (
        <>
          <button
            onClick={() => onOpenSettings(project)}
            title="Project settings (rename / move)"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "2px 4px",
            }}
          >
            <StatusDot status={majorityStatus(project, currentEff)} size={10} />
            <span
              style={{
                color: statusInk(AGENT_STATUS[majorityStatus(project, currentEff)].color),
                fontSize: 15,
                fontWeight: FONT_WEIGHT.semibold,
              }}
            >
              {project.name}
            </span>
          </button>
          {/* Where the per-agent dot cluster used to sit: the open-PR menu. Repo-scoped and
              agent-independent ON PURPOSE — the per-agent "Merge PR" CTA disappears with its agent,
              so a PR opened by a finished session goes invisible exactly when it's waiting to be
              merged. Renders nothing at zero, and nothing when the probe couldn't run (those are
              different facts, and neither is worth a "0"). Click to merge or jump to the agent. */}
          <OpenPrMenu
            rootPath={project.rootPath ?? null}
            resolveAgent={resolveAgentForPr}
            onOpenAgent={openAgentForPr}
          />
        </>
      ) : (
        <span style={{ color: C.muted, fontSize: 14 }}>No project open</span>
      )}

      {/* Push the actions to the right. */}
      <div style={{ flex: 1 }} />

      {/* Trial counter + Unlock — in-row, to the LEFT of the Recent/Open/⋯ + auth-status
          cluster, so it can never cover them. Only in trial mode; hides once the trial is spent. */}
      {inTrial && <TrialIndicator onUnlock={onTrialUnlock} signInFailedUrl={trialFailedUrl} />}

      <div style={{ position: "relative" }}>
        <button
          data-hint="recent"
          style={{ ...btn, position: "relative", zIndex: 42 }}
          onClick={() => setRecentOpen((v) => !v)}
        >
          Recent ▾
        </button>
        {recentOpen && (
          <>
            <div
              onClick={() => setRecentOpen(false)}
              style={{ position: "fixed", inset: 0, zIndex: 40 }}
            />
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 4,
                minWidth: 240,
                maxHeight: 360,
                overflowY: "auto",
                background: C.deepForest,
                border: `1px solid ${C.forest}`,
                borderRadius: 8,
                boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
                padding: 6,
                zIndex: 41,
              }}
            >
              {recent.length === 0 && (
                <div style={{ padding: "8px 10px", color: C.muted, fontSize: 13 }}>
                  No projects yet.
                </div>
              )}
              {recent.map((p) => {
                // Is this project already showing in some OTHER window? (A live registry entry
                // whose label isn't this window's.) If so, offer a "Switch" affordance that just
                // raises that window instead of replacing/reopening anything.
                const openLabel = findWindowForProject(p.id);
                const openElsewhere = openLabel != null && openLabel !== windowLabel;
                return (
                  <div
                    key={p.id}
                    data-hint={RECENT_HINT}
                    onClick={() => {
                      setRecentOpen(false);
                      openOrAsk({ kind: "existing", id: p.id });
                    }}
                    title={p.rootPath}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      borderRadius: 6,
                      cursor: "pointer",
                      background: p.id === currentProjectId ? C.forest : "transparent",
                    }}
                  >
                    <StatusDot status={majorityStatus(p, effStatus(p))} size={8} />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        color: C.cream,
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.name}
                    </span>
                    {openElsewhere && (
                      <button
                        data-hint={RECENT_SWITCH_HINT}
                        onClick={(e) => {
                          // Don't let the row's open-handler fire too — Switch only raises the
                          // existing window. openProjectInWindow focuses an already-open project
                          // regardless of mode, so this never spawns a duplicate. This also makes
                          // the keyboard hint safe: activating the switch chiclet fires el.click()
                          // on THIS button, and the row's open-here handler must not also run.
                          e.stopPropagation();
                          setRecentOpen(false);
                          route(p.id, "new");
                        }}
                        title="Bring the window already showing this project to the front"
                        style={{
                          flex: "0 0 auto",
                          background: "transparent",
                          color: C.teal,
                          border: `1px solid ${C.teal}`,
                          borderRadius: 6,
                          padding: "2px 8px",
                          fontSize: 12,
                          cursor: "pointer",
                          fontFamily: '"IBM Plex Sans", sans-serif',
                          whiteSpace: "nowrap",
                        }}
                      >
                        Switch
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* One entry point for getting a project into Sparkle: opens the folder / GitHub dialog.
          Reads "Open" at rest and expands to its full intent on hover. */}
      <button
        data-hint="open"
        // Stable accessible name: the VISIBLE label expands on hover/focus (compact "Open" at rest,
        // full intent on hover — a deliberate design choice), but assistive tech always hears the
        // full description, so the name doesn't churn under a screen reader.
        aria-label="Open (or Create) a Project Folder"
        style={{ ...btn, borderColor: C.teal, background: C.teal, color: ON_BRAND_FILL }}
        onMouseEnter={() => setOpenHover(true)}
        onMouseLeave={() => setOpenHover(false)}
        onFocus={() => setOpenHover(true)}
        onBlur={() => setOpenHover(false)}
        onClick={() => setNewProjectOpen(true)}
      >
        {openHover ? "Open (or Create) a Project Folder" : "Open"}
      </button>

      {/* ⋯ menu: opens the categorized settings dialog (SettingsDialog). */}
      <div style={{ position: "relative" }}>
        <button
          data-hint="menu"
          aria-label="More options"
          title="More options"
          style={{ ...btn, position: "relative", zIndex: 42, padding: "4px 10px", fontSize: 18, lineHeight: 1 }}
          onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
        >
          ⋯
        </button>
        {menuOpen && (
          <SettingsDialog
            initialCategory={settingsRequest ?? undefined}
            onClose={closeMenu}
            onManageAccounts={() => {
              closeMenu();
              setAccountsOpen(true);
            }}
          />
        )}
      </div>

      {/* Profile / auth-status control — sits just RIGHT of the ⋯ menu. Signed in → avatar;
          returning user → "Log in"; brand-new → "Sign up". All open the ⋯ menu's Accounts pane. */}
      <AuthStatusButton />

      {newProjectOpen && (
        <NewProjectDialog
          onClose={() => setNewProjectOpen(false)}
          // "From folder" runs the same picker/choice flow the old standalone Open button did.
          onOpenFromFolder={() => startOpen("Open or create a project folder")}
          // "Clone & Open" → create + open + select the cloned project, the SAME route resolveAndRoute
          // uses for a freshly-picked folder (so the new project becomes selected). Clone deliberately
          // opens in THIS window ("replace") rather than routing through the replace-vs-new prompt: the
          // user just committed to a brand-new clone via a multi-step dialog, so dropping them straight
          // into it (not asking a window-placement question) is the intended flow.
          onCloned={(name, path) => resolveAndRoute({ kind: "new", name, path }, "replace")}
        />
      )}

      {pending && (
        <OpenTargetDialog
          onChoose={(mode) => {
            const p = pending;
            setPending(null);
            // "target": folder already known (Recent) → route it. "pick": Open/New → NOW pop the
            // folder picker, with the mode the user just chose.
            if (p.type === "target") resolveAndRoute(p.target, mode);
            else void pickAndRoute(p.title, mode);
          }}
          onCancel={() => setPending(null)}
        />
      )}

      {/* Claude accounts settings (multi Claude Max support). Closing invalidates the selection
          cache so per-agent badges pick up any add/rename/remove. */}
      {accountsOpen && (
        <ModalShell
          width={520}
          onCancel={() => {
            setAccountsOpen(false);
            invalidateAccountState();
          }}
        >
          <AccountsScreen
            onLogin={(account) => {
              // Hand off to the interactive login modal; close the accounts list behind it.
              setAccountsOpen(false);
              setLoginAccount(account);
            }}
          />
        </ModalShell>
      )}

      {/* Interactive `claude login` PTY for a just-added account (AccountsScreen onLogin seam). */}
      {loginAccount && (
        <AccountLoginModal
          account={loginAccount}
          onClose={() => {
            setLoginAccount(null);
            invalidateAccountState();
          }}
        />
      )}
    </div>
  );
}
