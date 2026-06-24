import { useEffect, useState } from "react";
import { C, FONT_WEIGHT } from "@sparkle/ui";
import type { AgentTab, Project } from "../types";
import { prepareAgentWorkspace } from "../services/worktree";
import { checkClaude } from "../preflight";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { PinnedPrompt } from "./PinnedPrompt";
import { Terminal } from "./Terminal";
import { Composer } from "./Composer";
import { Onboarding } from "./Onboarding";

type Phase = "preparing" | "ready" | "no-claude" | "error";

// macOS default login shell. We launch `claude` through `zsh -l -c 'exec …'` so the
// agent (and the tools claude itself shells out to) inherit the user's real PATH/env —
// GUI apps otherwise get a minimal PATH and can't find node/git/etc.
const SHELL = "/bin/zsh";

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

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

  const prepare = async () => {
    setPhase("preparing");
    setErrorMsg("");
    setPtyReady(false);
    try {
      const wt = await prepareAgentWorkspace(project.rootPath, agent.id);
      setAgentWorktree(project.id, agent.id, wt.path, wt.branch);
      const claude = await checkClaude();
      if (!claude.installed || !claude.path) {
        setPhase("no-claude");
        return;
      }
      setSpawn({
        command: SHELL,
        args: ["-l", "-c", `exec ${shellQuote(claude.path)}`],
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
        <>
          <div style={{ flex: 1, minHeight: 0, padding: 6 }}>
            <Terminal
              agentId={agent.id}
              command={spawn.command}
              args={spawn.args}
              cwd={spawn.cwd}
              active={visible}
              onStatus={(s) => setStatus(agent.id, s)}
              onReady={() => setPtyReady(true)}
            />
          </div>
          <Composer
            agentId={agent.id}
            disabled={!ptyReady}
            onSubmitPrompt={(t) => setLastPrompt(project.id, agent.id, t)}
          />
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
