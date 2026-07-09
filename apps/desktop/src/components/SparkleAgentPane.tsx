import { useEffect, useRef, useState } from "react";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { createAgentWorktree, installWorktreeGuard, assertWorkspaceIntegrity } from "../services/worktree";
import { checkClaude, claudeHasSession } from "../preflight";
import { buildClaudeExec } from "../services/claudeSpawn";
import { cancelImprovementPass } from "../services/improvementPass";
import {
  ensureSparkleRepo,
  sparklePersona,
  sparkleMissionPrompt,
  sparkleChatOnlyMissionPrompt,
  SPARKLE_PROJECT_ID,
} from "../services/sparkleAgent";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { PinnedPrompt } from "./PinnedPrompt";
import { SparkleConsentBanner } from "./SparkleConsentBanner";
import { Terminal } from "./Terminal";
import { Composer } from "./Composer";
import { Onboarding } from "./Onboarding";
import { paneVisibilityStyle } from "./paneVisibility";

type Phase = "preparing" | "ready" | "no-claude" | "error";

const SHELL = "/bin/zsh";

interface SpawnCmd {
  command: string;
  args: string[];
  cwd: string;
  projectRootPath: string;
  // Whether this spawn resumes a prior Claude session (`claude --resume`) vs starts fresh — drives
  // the Terminal's loading affordance ("Resuming conversation…" vs "Starting Claude…").
  resuming: boolean;
}

/**
 * The Sparkle self-improvement agent's pane. Structurally mirrors AgentPane, but instead of
 * the user's project it prepares an app-owned clone of the open-source Sparkle repo, passes the
 * log dir to the agent (--add-dir, for review), and launches `claude` with the improvement
 * persona + an opening mission prompt so the user immediately sees it working. See
 * services/sparkleAgent.ts.
 *
 * `agentId` is this WINDOW's Sparkle id (sparkleAgentIdFor(windowLabel)). Improve Sparkle is
 * per-window — each window runs its own copy off a distinct worktree/branch cut from the single
 * shared clone — so the id keys this pane's worktree, PTY, and status independently of other
 * windows'. Closing the pane keeps the worktree, so reopening in the same window resumes.
 */
export function SparkleAgentPane({ visible, agentId }: { visible: boolean; agentId: string }) {
  const [phase, setPhase] = useState<Phase>("preparing");
  const [errorMsg, setErrorMsg] = useState("");
  const [spawn, setSpawn] = useState<SpawnCmd | null>(null);
  const [ptyReady, setPtyReady] = useState(false);
  const [lastPrompt, setLastPrompt] = useState("");
  const setStatus = useRuntimeStore((s) => s.setStatus);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const termFocusRef = useRef<(() => void) | null>(null);
  const composerMinimized = useUiStore((s) => s.composerMinimized);

  const prepare = async () => {
    setPhase("preparing");
    setErrorMsg("");
    setPtyReady(false);
    try {
      // If an hourly headless pass is mid-flight (improvementPass.ts), kill it first: two
      // `claude` processes must never share this worktree. Nothing is lost — the interactive
      // session below resumes the worktree's most recent conversation, including the pass's.
      await cancelImprovementPass().catch(() => {});
      // App-owned workspace: clone the OSS repo (once) + locate the log dir. Never the user's project.
      const ws = await ensureSparkleRepo();
      // Cut this agent's isolated worktree off the clone's actual default branch (reuses the normal
      // worktree machinery; the clone already has a born HEAD so no ensure_project_repo needed).
      const wt = await createAgentWorktree(
        ws.repoPath,
        SPARKLE_PROJECT_ID,
        agentId,
        ws.defaultBranch,
      );
      try {
        await installWorktreeGuard(wt.path);
      } catch (e) {
        console.warn("guard install failed (relocation still protects):", e);
      }
      await assertWorkspaceIntegrity(wt.path);
      const claude = await checkClaude();
      if (!claude.installed || !claude.path) {
        setPhase("no-claude");
        return;
      }
      const resume = await claudeHasSession(wt.path).catch(() => false);
      // Consent gates what the agent may do (bead sparkle-4xwk.1). Read at prepare() time — the
      // spawned command is built here, so a consent change while a session is already running is
      // picked up on the next prepare/resume, not mid-session.
      const consent = useSettingsStore.getState().sparkleImprovementConsent;
      setSpawn({
        command: SHELL,
        args: [
          "-l",
          "-c",
          buildClaudeExec(claude.path, resume, {
            appendSystemPrompt: sparklePersona(ws.logDir, wt.path, consent),
            // "Never" = chat-only: don't even grant the agent read access to the log dir, and open
            // with an introduction instead of a log-review mission.
            ...(consent === "never" ? {} : { addDirs: [ws.logDir] }),
            initialPrompt:
              consent === "never" ? sparkleChatOnlyMissionPrompt() : sparkleMissionPrompt(),
          }),
        ],
        cwd: wt.path,
        projectRootPath: ws.repoPath,
        resuming: resume,
      });
      setPhase("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  useEffect(() => {
    void prepare();
    // Prepare once on mount; this window's Sparkle id is fixed for the pane's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus follows the minimized state: minimized → terminal (answer Claude's menus),
  // restored → composer (type in the box). Mirrors AgentPane.
  useEffect(() => {
    if (!visible || !ptyReady) return;
    const raf = requestAnimationFrame(() => {
      if (composerMinimized) termFocusRef.current?.();
      else composerInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [composerMinimized, visible, ptyReady]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        // Hide an inactive pane WITHOUT collapsing its box (no `display: none`) so its terminal
        // stays measured and never re-renders into a thin column on reveal. See paneVisibility.ts.
        ...paneVisibilityStyle(visible),
        flexDirection: "column",
        background: C.forest,
      }}
    >
      <PinnedPrompt prompt={lastPrompt || "Sparkle Improvement Agent — making Sparkle better from your usage"} />
      <SparkleConsentBanner />

      {phase === "preparing" && <Centered>Preparing the Sparkle improvement workspace…</Centered>}
      {phase === "error" && (
        <Centered>
          <div style={{ color: C.sienna, marginBottom: 10 }}>Couldn't start the Sparkle agent</div>
          <div style={{ color: C.muted, fontSize: 13, maxWidth: 480, marginBottom: 16 }}>{errorMsg}</div>
          <PrimaryButton onClick={() => void prepare()}>Try again</PrimaryButton>
        </Centered>
      )}
      {phase === "no-claude" && <Onboarding onRetry={() => void prepare()} />}
      {phase === "ready" && spawn && (
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <div style={{ position: "absolute", inset: 0, padding: 6 }}>
            <Terminal
              agentId={agentId}
              projectId={SPARKLE_PROJECT_ID}
              projectRootPath={spawn.projectRootPath}
              command={spawn.command}
              args={spawn.args}
              cwd={spawn.cwd}
              resuming={spawn.resuming}
              active={visible}
              onStatus={(s) => setStatus(agentId, s)}
              onReady={() => setPtyReady(true)}
              onRequestFocus={() => composerInputRef.current?.focus()}
              focusRef={termFocusRef}
            />
          </div>
          <Composer
            agentId={agentId}
            active={visible}
            disabled={!ptyReady}
            inputRef={composerInputRef}
            onSubmitPrompt={(t) => setLastPrompt(t)}
          />
        </div>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        color: C.muted,
        padding: 24,
      }}
    >
      {children}
    </div>
  );
}

function PrimaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: C.teal,
        color: ON_BRAND_FILL,
        border: "none",
        borderRadius: 8,
        padding: "9px 18px",
        fontWeight: FONT_WEIGHT.semibold,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
