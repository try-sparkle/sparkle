import { useEffect, useRef, useState } from "react";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT } from "../theme/colors";
import type { AgentTab, Project } from "../types";
import { prepareAgentWorkspace, installWorktreeGuard, assertWorkspaceIntegrity } from "../services/worktree";
import { resolveDefaultBranch } from "../services/branchStatus";
import { checkClaude, claudeHasSession } from "../preflight";
import { buildClaudeExec } from "../services/claudeSpawn";
import { workerPersona, workerMission, WORKER_RESULT_RELPATH, parseWorkerResult } from "../services/buildAgent";
import { readWorkerResult } from "../pty";
import { maybeAutoName } from "../services/agentNaming";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { PinnedPrompt } from "./PinnedPrompt";
import { Terminal, type TerminalApi } from "./Terminal";
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
  const appendPrompt = useProjectStore((s) => s.appendPrompt);
  const setStatus = useRuntimeStore((s) => s.setStatus);
  // Tracks whether the last spawn was a fresh session (not a --continue resume). Used in the
  // worker exit handler to skip stale result re-reads on resumed sessions.
  const wasFreshLaunchRef = useRef(false);
  // The composer's textarea — initial focus lands here when a tab opens.
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  // The terminal's imperative focus(), so we can move focus into it when the composer
  // minimizes (or on ⌘J) without the user clicking the terminal.
  const termFocusRef = useRef<(() => void) | null>(null);
  const composerMinimized = useUiStore((s) => s.composerMinimized);
  // Imperative bridge to the terminal: mark where each prompt was sent, scroll back to it on pick.
  const terminalApiRef = useRef<TerminalApi | null>(null);
  // Brief toast when a picked prompt's line has scrolled out of the terminal's history.
  const [scrolledOut, setScrolledOut] = useState(false);
  const scrolledOutTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (scrolledOutTimer.current) window.clearTimeout(scrolledOutTimer.current);
  }, []);
  const flashScrolledOut = () => {
    setScrolledOut(true);
    if (scrolledOutTimer.current) window.clearTimeout(scrolledOutTimer.current);
    scrolledOutTimer.current = window.setTimeout(() => setScrolledOut(false), 2600);
  };

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
      // Record whether this is a fresh launch so the worker exit handler can
      // distinguish a first-run (which should produce result.json) from a
      // reopened/resumed session (where result.json was already consumed earlier).
      // Known Plan-1 limitation: the ref tracks the LATEST prepare(), not a per-PTY
      // snapshot. If a worker tab is reopened (a second prepare() with resume=true)
      // while its first PTY is still running, that first PTY's exit will read the
      // newer `false` and skip the result log. This only loses a console line on an
      // improbable reopen-while-running race; per-result tracking is deferred to Plan 2.
      wasFreshLaunchRef.current = !resume;
      let exec: string;
      if (agent.kind === "worker") {
        // The persona's parentBranch is the PARENT build agent's branch (what the worker was cut
        // from) — resolve it via parentId. Do NOT use agent.baseBranch: that's the logical
        // integration branch (e.g. "main"), which differs from what spawnWorker passed to
        // create_worker_worktree (the parent build agent's actual working branch).
        // Prefer the branch persisted at spawn time (agent.parentBranch); fall back to the
        // live parent agent record. If neither resolves, warn — the worker persona will have
        // a blank parentBranch, which is a configuration issue but not fatal.
        const liveParentBranch = project.agents.find((a) => a.id === agent.parentId)?.branch;
        const parentBranch = agent.parentBranch ?? liveParentBranch ?? "";
        if (!parentBranch) {
          console.warn(`[worker ${agent.id}] no resolvable parent branch — parentBranch will be empty in persona`);
        }
        const resultPath = `${wt.path}/${WORKER_RESULT_RELPATH}`;
        exec = buildClaudeExec(claude.path, resume, {
          appendSystemPrompt: workerPersona({ parentBranch, resultPath }),
          initialPrompt: workerMission(agent.task ?? "", agent.id),
        });
      } else {
        exec = buildClaudeExec(claude.path, resume);
      }
      setSpawn({
        command: SHELL,
        args: ["-l", "-c", exec],
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
      <PinnedPrompt
        prompt={agent.lastPrompt}
        history={agent.promptHistory ?? []}
        onSelectPrompt={(id) => {
          // scrollToPrompt returns false when the line has scrolled out of the buffer (or the
          // marker never existed — e.g. a prompt from a previous session after a restart).
          if (!terminalApiRef.current?.scrollToPrompt(id)) flashScrolledOut();
        }}
      />

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
              onExit={() => {
                // NOTE (Plan-1 limitation): this block fires only when the PTY process actually
                // exits — i.e. the user explicitly quits `claude` (e.g. /exit). Because
                // buildClaudeExec launches `claude` in its interactive REPL mode, an active worker
                // that finishes its task and writes result.json will remain alive in the REPL; it
                // does NOT exit. The Terminal component also removes its exit listener before
                // killPty, so a programmatic kill won't reach here either. In practice this
                // block rarely fires for interactive workers. Plan 2 reads result.json by polling
                // via `read_worker_result` — NOT on PTY exit.
                //
                // Only read result.json for worker agents on a FRESH launch. A resumed worker
                // already reported (and the result was consumed) in an earlier session; re-reading
                // would re-announce a stale file. Per-result de-dup tracking is Plan 2 — gating
                // the whole read on wasFreshLaunch is sufficient for Plan 1.
                if (wasFreshLaunchRef.current && agent.kind === "worker" && agent.worktreePath) {
                  readWorkerResult(agent.worktreePath)
                    .then((raw) => {
                      if (!raw) {
                        console.warn(`[worker ${agent.id}] exited with no result.json`);
                        return;
                      }
                      const r = parseWorkerResult(raw);
                      console.info(`[worker ${agent.id}] ${r.status}: ${r.summary}`);
                    })
                    .catch((e) => console.error(`[worker ${agent.id}] bad result.json`, e));
                }
              }}
              onRequestFocus={() => composerInputRef.current?.focus()}
              focusRef={termFocusRef}
              apiRef={terminalApiRef}
            />
          </div>
          <Composer
            agentId={agent.id}
            active={visible}
            disabled={!ptyReady}
            inputRef={composerInputRef}
            onSubmitPrompt={(t) => {
              // Record the prompt (pinned header + history) and mark where it landed in the
              // terminal so the history dropdown can scroll back to it later.
              const id = appendPrompt(project.id, agent.id, t);
              terminalApiRef.current?.markPrompt(id);
              // Fire-and-forget: summarize the work into a short name (first prompt, or when
              // the work shifts). No-ops if the name is pinned or no API key is configured.
              void maybeAutoName(project.id, agent.id, t);
            }}
          />
          {scrolledOut && <ScrolledOutToast />}
        </div>
      )}
        </>
      )}
    </div>
  );
}

// Shown briefly when a picked history prompt can't be located in the terminal's scrollback
// (its line aged out of the 8000-line buffer, or it's from a previous session). Mirrors the
// terminal's copy-confirmation toast styling. pointer-events:none so it never blocks the UI.
function ScrolledOutToast() {
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        padding: "6px 14px",
        borderRadius: 8,
        background: C.deepForest,
        color: C.cream,
        border: `1px solid ${CHAT_USER_BUBBLE}`,
        fontFamily: '"IBM Plex Sans", sans-serif',
        fontSize: 13,
        boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
        pointerEvents: "none",
        zIndex: 30,
      }}
    >
      ⌁ That part of the conversation has scrolled out of the terminal's history
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
