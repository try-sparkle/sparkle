import { useEffect, useState, type CSSProperties } from "react";
import { FiCloud, FiX } from "react-icons/fi";
import { C, DANGER, ON_BRAND_FILL } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import type { Project } from "../types";
import { useUiStore } from "../stores/uiStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useCloudAuthStore } from "../stores/cloudAuthStore";
import { useCloudGate } from "../hooks/useCloudAgents";
import { cloudApi } from "../services/cloudAgents/api";
import { createCloudAgent } from "../services/cloudAgents/create";
import { projectBindingSets } from "../services/cloudAgents/projectBinding";
import { ensureCloudProjectId } from "../services/cloudAgents/projectLink";
import { projectRepoUrl } from "../services/cloudAgents/repoUrl";
import { classifyStartError, type StartGuidance } from "../services/cloudAgents/startError";
import { openSignIn } from "../services/sparkleApi";

// "New cloud agent" (Service B, W5). A cloud agent is started server-side BEFORE it has a tab, and
// the server needs a goal and a repo up front (it clones the repo and seeds Claude Code with the
// goal) — so unlike a local agent, which you create empty and then talk to, this one is created
// from a small form.
//
// Everything blocking is surfaced honestly and with a way out:
//   • the pure client gate (gating.ts) decides whether a click may even be attempted, and hands us
//     the Settings section to deep-link to when it can't;
//   • the server's refusal is the DEFINITIVE answer, classified by startError.ts into the same
//     shape, so a 402/400/403 lands the user on the same fix path as the local pre-check would.
// Nothing here claims a start will succeed, and no tab is created unless one really started.

export function NewCloudAgentDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const gate = useCloudGate();
  const openSettings = useUiStore((s) => s.openSettings);
  const refreshAuth = useCloudAuthStore((s) => s.refresh);
  const authLoaded = useCloudAuthStore((s) => s.loaded);

  const [goal, setGoal] = useState("");
  const [name, setName] = useState("");
  const [starting, setStarting] = useState(false);
  const [guidance, setGuidance] = useState<StartGuidance | null>(null);

  // The gate's `authConfigured` reads the cloudAuthStore, which is not persisted — probe once on
  // open so the "add your Claude auth" block reflects the SERVER's answer rather than a cold store.
  useEffect(() => {
    if (!authLoaded) void refreshAuth();
  }, [authLoaded, refreshAuth]);

  const start = async () => {
    const trimmedGoal = goal.trim();
    if (!trimmedGoal || starting) return;
    setStarting(true);
    setGuidance(null);
    try {
      // The repo is required: the sandbox clones it. Refuse rather than send a bad URL and let the
      // user discover it as an opaque server-side clone failure minutes later.
      const repoUrl = await projectRepoUrl(project.rootPath);
      if (!repoUrl) {
        setGuidance({
          reason: "generic",
          message:
            "Couldn't determine this project's GitHub repository. A cloud agent clones the repo, so the project needs a GitHub remote (and the gh CLI signed in).",
        });
        return;
      }

      // A cloud session is keyed to the ORCHESTRATION project row, not this local project's
      // locally-minted id — resolve (or create) it once and cache it on the project record.
      const cloudProjectId = await ensureCloudProjectId(project, {
        api: cloudApi,
        remember: (localId, cloudId) => useProjectStore.getState().setCloudProjectId(localId, cloudId),
        ...projectBindingSets(project.id),
      });

      const ps = useProjectStore.getState();
      const res = await createCloudAgent(
        {
          projectId: cloudProjectId,
          goal: trimmedGoal,
          repoUrl,
          ...(project.defaultBranch ? { baseBranch: project.defaultBranch } : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
        },
        {
          api: cloudApi,
          // The store deps deliberately ignore the id they're handed: `createCloudAgent` passes the
          // id it sent to the SERVER, while the tab belongs to the LOCAL project record. Injecting
          // the deps is exactly the seam that lets the caller resolve that split.
          addAgent: (_serverProjectId, opts) => ps.addAgent(project.id, opts),
          selectAgent: (_serverProjectId, agentId) => ps.selectAgent(project.id, agentId),
          open: (agentId) => useRuntimeStore.getState().open(agentId),
          reveal: (agentId) => useUiStore.getState().requestRevealAgent(agentId),
        },
      );

      if (res.ok) {
        onClose();
        return;
      }
      setGuidance(res.guidance);
    } catch (err) {
      // Anything the project-link / repo lookup threw (offline, signed out, server error) goes
      // through the SAME classifier, so the user gets one consistent set of fixes.
      setGuidance(classifyStartError(err));
    } finally {
      setStarting(false);
    }
  };

  const goToSettings = (cat: Parameters<typeof openSettings>[0]) => {
    openSettings(cat);
    onClose();
  };

  // A blocked gate replaces the form: there is nothing useful to type until it's fixed.
  const blocked = !gate.ok ? gate : null;
  // `started_untracked` = the session IS already running server-side; another Start would spawn (and
  // bill) a second sandbox for the same goal, so the button stays down.
  const startDisabled =
    starting || goal.trim().length === 0 || guidance?.reason === "started_untracked";

  return (
    <>
      <div data-testid="cloud-dialog-backdrop" onClick={onClose} style={backdrop} />
      <div role="dialog" aria-modal="true" aria-label="New cloud agent" style={dialog}>
        <div style={titleBar}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 17, fontWeight: FONT_WEIGHT.semibold }}>
            <FiCloud size={16} />
            New cloud agent
          </div>
          <button type="button" aria-label="Close" onClick={onClose} style={closeBtn}>
            <FiX size={18} />
          </button>
        </div>

        <div style={body}>
          {blocked ? (
            <div style={panel} data-testid="cloud-gate-block">
              <div style={{ fontSize: 13, color: C.cream }}>{blocked.message}</div>
              {blocked.needsSignIn && (
                <button type="button" style={primaryBtn} onClick={() => void openSignIn()}>
                  Sign in
                </button>
              )}
              {blocked.deepLink && (
                <button type="button" style={actionBtn} onClick={() => goToSettings(blocked.deepLink!)}>
                  {blocked.deepLink === "cloudauth" ? "Add Claude auth" : "Open credits"}
                </button>
              )}
            </div>
          ) : (
            <>
              <div style={hint}>
                Runs in a Sparkle sandbox on {repoLabel(project)} — it keeps working with your laptop
                closed, and bills credits for each running minute.
              </div>

              <label htmlFor="cloud-goal" style={fieldLabel}>
                What should it do?
              </label>
              <textarea
                id="cloud-goal"
                data-testid="cloud-goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={4}
                placeholder="Fix the flaky checkout test and open a PR"
                style={textarea}
              />

              <label htmlFor="cloud-name" style={fieldLabel}>
                Name (optional)
              </label>
              <input
                id="cloud-name"
                data-testid="cloud-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Leave empty to name it automatically"
                style={input}
              />

              <button
                type="button"
                // One predicate for both the disabled state and the dimming — a fully-opaque button
                // that refuses clicks reads as broken (roborev 46881).
                style={{ ...primaryBtn, opacity: startDisabled ? 0.5 : 1 }}
                onClick={() => void start()}
                disabled={startDisabled}
              >
                <FiCloud size={13} />
                {starting ? "Starting…" : "Start cloud agent"}
              </button>
            </>
          )}

          {guidance && (
            <div style={panel} data-testid="cloud-start-error">
              <div style={errorText}>{guidance.message}</div>
              {guidance.needsSignIn && (
                <button type="button" style={actionBtn} onClick={() => void openSignIn()}>
                  Sign in
                </button>
              )}
              {guidance.deepLink && (
                <button type="button" style={actionBtn} onClick={() => goToSettings(guidance.deepLink!)}>
                  {guidance.deepLink === "cloudauth" ? "Add Claude auth" : "Open credits"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** A short, honest label for where the agent will run — the project name is all we know for sure
 *  before the repo lookup runs. */
function repoLabel(project: Project): string {
  return project.name || "this project";
}

// ── styles ───────────────────────────────────────────────────────────────────

const backdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  zIndex: 60,
};

const dialog: CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: 460,
  maxWidth: "90vw",
  background: C.barSurface,
  color: C.cream,
  borderRadius: 6,
  zIndex: 61,
  display: "flex",
  flexDirection: "column",
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

const titleBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 16px",
  borderBottom: `1px solid ${C.hairline}`,
};

const closeBtn: CSSProperties = {
  display: "grid",
  placeItems: "center",
  background: "transparent",
  border: "none",
  color: C.muted,
  cursor: "pointer",
};

const body: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 16,
};

const panel: CSSProperties = {
  background: C.forest,
  borderRadius: 6,
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  alignItems: "flex-start",
};

const hint: CSSProperties = { fontSize: 12, color: C.muted, lineHeight: 1.5 };

const fieldLabel: CSSProperties = { fontSize: 12, color: C.cream, marginTop: 4 };

const errorText: CSSProperties = { fontSize: 12, color: DANGER, lineHeight: 1.5 };

const fieldBase: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: C.forest,
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 13,
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

const input: CSSProperties = fieldBase;
const textarea: CSSProperties = { ...fieldBase, resize: "vertical" };

const actionBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "7px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

const primaryBtn: CSSProperties = {
  ...actionBtn,
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
};
