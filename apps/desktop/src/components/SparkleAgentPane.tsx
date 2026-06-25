import { useEffect, useRef, useState } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import { createAgentWorktree, installWorktreeGuard, assertWorkspaceIntegrity } from "../services/worktree";
import { checkClaude, claudeHasSession } from "../preflight";
import { buildClaudeExec } from "../services/claudeSpawn";
import {
  ensureSparkleRepo,
  sparklePersona,
  sparkleMissionPrompt,
  SPARKLE_AGENT_ID,
  SPARKLE_PROJECT_ID,
} from "../services/sparkleAgent";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { PinnedPrompt } from "./PinnedPrompt";
import { Terminal } from "./Terminal";
import { Composer } from "./Composer";
import { Onboarding } from "./Onboarding";

type Phase = "preparing" | "ready" | "no-claude" | "error";

const SHELL = "/bin/zsh";

interface SpawnCmd {
  command: string;
  args: string[];
  cwd: string;
  projectRootPath: string;
}

/**
 * The Sparkle self-improvement agent's pane. Structurally mirrors AgentPane, but instead of
 * the user's project it prepares an app-owned clone of the open-source Sparkle repo, passes the
 * log dir to the agent (--add-dir, for review), and launches `claude` with the improvement
 * persona + an opening mission prompt so the user immediately sees it working. See
 * services/sparkleAgent.ts.
 */
export function SparkleAgentPane({ visible }: { visible: boolean }) {
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
      // App-owned workspace: clone the OSS repo (once) + locate the log dir. Never the user's project.
      const ws = await ensureSparkleRepo();
      // Cut this agent's isolated worktree off the clone's actual default branch (reuses the normal
      // worktree machinery; the clone already has a born HEAD so no ensure_project_repo needed).
      const wt = await createAgentWorktree(
        ws.repoPath,
        SPARKLE_PROJECT_ID,
        SPARKLE_AGENT_ID,
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
      setSpawn({
        command: SHELL,
        args: [
          "-l",
          "-c",
          buildClaudeExec(claude.path, resume, {
            appendSystemPrompt: sparklePersona(ws.logDir, wt.path),
            addDirs: [ws.logDir],
            initialPrompt: sparkleMissionPrompt(),
          }),
        ],
        cwd: wt.path,
        projectRootPath: ws.repoPath,
      });
      setPhase("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  useEffect(() => {
    void prepare();
    // Prepare once; this pane is a singleton for the app's life.
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
        display: visible ? "flex" : "none",
        flexDirection: "column",
        background: C.forest,
      }}
    >
      <PinnedPrompt prompt={lastPrompt || "Sparkle Improvement Agent — making Sparkle better from your usage"} />

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
              agentId={SPARKLE_AGENT_ID}
              projectId={SPARKLE_PROJECT_ID}
              projectRootPath={spawn.projectRootPath}
              command={spawn.command}
              args={spawn.args}
              cwd={spawn.cwd}
              active={visible}
              onStatus={(s) => setStatus(SPARKLE_AGENT_ID, s)}
              onReady={() => setPtyReady(true)}
              onRequestFocus={() => composerInputRef.current?.focus()}
              focusRef={termFocusRef}
            />
          </div>
          <Composer
            agentId={SPARKLE_AGENT_ID}
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
        color: C.cream,
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
