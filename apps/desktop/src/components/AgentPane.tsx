import { useEffect, useRef, useState } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import type { AgentTab, Project } from "../types";
import { prepareAgentWorkspace, installWorktreeGuard, assertWorkspaceIntegrity } from "../services/worktree";
import { resolveDefaultBranch } from "../services/branchStatus";
import { checkClaude, claudeHasSession } from "../preflight";
import { buildClaudeExec } from "../services/claudeSpawn";
import { maybeAutoName } from "../services/agentNaming";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { PinnedPrompt } from "./PinnedPrompt";
import { Terminal } from "./Terminal";
import { Composer } from "./Composer";
import { Onboarding } from "./Onboarding";
import { BrainstormPanel } from "./BrainstormPanel";

type Phase = "preparing" | "ready" | "no-claude" | "error";

// macOS default login shell. We launch `claude` through `zsh -l -c 'exec …'` so the
// agent (and the tools claude itself shells out to) inherit the user's real PATH/env —
// GUI apps otherwise get a minimal PATH and can't find node/git/etc.
const SHELL = "/bin/zsh";

interface SpawnCmd {
  command: string;
  args: string[];
  cwd: string;
}

export function AgentPane({
  project,
  agent,
  visible,
}: {
  project: Project;
  agent: AgentTab;
  visible: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("preparing");
  const [errorMsg, setErrorMsg] = useState("");
  const [spawn, setSpawn] = useState<SpawnCmd | null>(null);
  const [ptyReady, setPtyReady] = useState(false);
  const setAgentWorktree = useProjectStore((s) => s.setAgentWorktree);
  const setLastPrompt = useProjectStore((s) => s.setLastPrompt);
  const setStatus = useRuntimeStore((s) => s.setStatus);
  // The composer's textarea — initial focus lands here when a tab opens.
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  // The terminal's imperative focus(), so we can move focus into it when the composer
  // minimizes (or on ⌘J) without the user clicking the terminal.
  const termFocusRef = useRef<(() => void) | null>(null);
  const composerMinimized = useUiStore((s) => s.composerMinimized);

  const prepare = async () => {
    // Brainstorm agents are a Chief chat — no worktree, no PTY, nothing to prepare.
    if (agent.kind === "brainstorm") return;
    setPhase("preparing");
    setErrorMsg("");
    setPtyReady(false);
    try {
      // Resolve + persist the project's integration branch once, then base this agent off it.
      // Normalize a possibly-empty resolver result the same way the store does, so the worktree
      // and poll layers don't see a value the store guard would have nulled.
      let base = project.defaultBranch;
      if (!base) {
        const resolved = (await resolveDefaultBranch(project.rootPath)).trim();
        base = resolved || null;
        if (base) useProjectStore.getState().setDefaultBranch(project.id, base);
      }
      // An agent created before defaultBranch existed has a null baseBranch — backfill it.
      // An empty agentBase is tolerated by the Rust effective_base fallback.
      const agentBase = agent.baseBranch ?? base ?? "";
      const wt = await prepareAgentWorkspace(project.rootPath, project.id, agent.id, agentBase);
      setAgentWorktree(project.id, agent.id, wt.path, wt.branch);
      // Defense in depth: install the write-guard, then refuse to spawn a broken sandbox.
      try {
        await installWorktreeGuard(wt.path);
      } catch (e) {
        console.warn("guard install failed (relocation still protects):", e);
      }
      await assertWorkspaceIntegrity(wt.path); // throws → caught below → error phase, no spawn
      // Poll branch status only after the workspace passed integrity — never for a sandbox we
      // are about to reject.
      void useRuntimeStore
        .getState()
        .pollBranchStatus(project.rootPath, project.id, agent.id, agentBase);
      const claude = await checkClaude();
      if (!claude.installed || !claude.path) {
        setPhase("no-claude");
        return;
      }
      // Resume the prior conversation if this worktree already has one (the
      // worktree path is the session key). `--continue` errors in a directory
      // with no history, so only add it when a session exists. Resume is a
      // best-effort enhancement: if detection fails, fall back to a fresh
      // `claude` rather than blocking the agent from starting at all.
      const resume = await claudeHasSession(wt.path).catch(() => false);
      setSpawn({
        command: SHELL,
        args: ["-l", "-c", buildClaudeExec(claude.path, resume)],
        cwd: wt.path,
      });
      setPhase("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  useEffect(() => {
    void prepare();
    // Prepare once per agent (agent.id is stable for this component's life).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  // Focus follows the minimized state on the visible pane: minimized → terminal (so the user
  // can answer Claude's menus), restored → composer (so they type in the box). Drives both the
  // drag-to-minimize path and ⌘J. rAF lets the just-rendered surface mount/show first.
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
      {/* Brainstorm agents render a Chief chat instead of a Claude terminal. */}
      {agent.kind === "brainstorm" && <BrainstormPanel project={project} agentId={agent.id} />}

      {agent.kind !== "brainstorm" && (
        <>
      <PinnedPrompt prompt={agent.lastPrompt} />

      {phase === "preparing" && (
        <Centered>Preparing your agent's safe workspace…</Centered>
      )}
      {phase === "error" && (
        <Centered>
          <div style={{ color: C.sienna, marginBottom: 10 }}>Couldn't start this agent</div>
          <div style={{ color: C.muted, fontSize: 13, maxWidth: 480, marginBottom: 16 }}>
            {errorMsg}
          </div>
          <PrimaryButton onClick={() => void prepare()}>Try again</PrimaryButton>
        </Centered>
      )}
      {phase === "no-claude" && <Onboarding onRetry={() => void prepare()} />}
      {phase === "ready" && spawn && (
        // Relative stage: the terminal fills it; the composer floats over the bottom as an
        // overlay (so dragging the composer never resizes/reflows the terminal beneath it).
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <div style={{ position: "absolute", inset: 0, padding: 6 }}>
            <Terminal
              agentId={agent.id}
              command={spawn.command}
              args={spawn.args}
              cwd={spawn.cwd}
              active={visible}
              onStatus={(s) => setStatus(agent.id, s)}
              onReady={() => setPtyReady(true)}
              onRequestFocus={() => composerInputRef.current?.focus()}
              focusRef={termFocusRef}
            />
          </div>
          <Composer
            agentId={agent.id}
            active={visible}
            disabled={!ptyReady}
            inputRef={composerInputRef}
            onSubmitPrompt={(t) => {
              setLastPrompt(project.id, agent.id, t);
              // Fire-and-forget: summarize the work into a short name (first prompt, or when
              // the work shifts). No-ops if the name is pinned or no API key is configured.
              void maybeAutoName(project.id, agent.id, t);
            }}
          />
        </div>
      )}
        </>
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

function PrimaryButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
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
