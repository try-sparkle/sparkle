import { useEffect, useRef, useState } from "react";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { createAgentWorktree, installWorktreeGuard, assertWorkspaceIntegrity } from "../services/worktree";
import { checkClaude, claudeHasSession } from "../preflight";
import { buildClaudeExec } from "../services/claudeSpawn";
import { cancelImprovementPass } from "../services/improvementPass";
import {
  checkSubmitCapability,
  ensureSparkleRepo,
  sparklePersona,
  sparkleMissionPrompt,
  sparkleChatOnlyMissionPrompt,
  submitBlockedReason,
  SPARKLE_PROJECT_ID,
} from "../services/sparkleAgent";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { PinnedPrompt } from "./PinnedPrompt";
import { SparkleConsentBanner } from "./SparkleConsentBanner";
import { Terminal, type TerminalApi } from "./Terminal";
import { Composer } from "./Composer";
import { Onboarding } from "./Onboarding";
import { paneVisibilityStyle } from "./paneVisibility";
import { focusQuietly } from "../services/programmaticFocus";
import { useDictationStore } from "../stores/dictationStore";

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
  // Why this machine can't open PRs, if it can't (null = it can, or we couldn't tell). Set during
  // prepare() so the pane says the same thing the agent was told — see submitBlockedReason.
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const setStatus = useRuntimeStore((s) => s.setStatus);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const termFocusRef = useRef<(() => void) | null>(null);
  const terminalApiRef = useRef<TerminalApi | null>(null);
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
      // Can this machine actually submit? Asked here, once per prepare, so the persona and the
      // notice below agree — and so a read-only user learns it up front instead of after a full
      // session ends in a 403. A failed probe is "unknown": the normal submitting path stays.
      const submit = await checkSubmitCapability().catch(() => null);
      setSubmitNotice(submit ? submitBlockedReason(submit.verdict, submit.repo) : null);
      setSpawn({
        command: SHELL,
        args: [
          "-l",
          "-c",
          buildClaudeExec(claude.path, resume, {
            appendSystemPrompt: sparklePersona(
              ws.logDir,
              wt.path,
              consent,
              submit?.verdict ?? "unknown",
              // The pane IS the user sitting in the chat, so an auth failure is theirs to clear.
              { attended: true },
            ),
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
      else focusQuietly(composerInputRef.current);
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
      {/* Submission is the last step of every pass and the one most likely to be unavailable — a
          public user has read-only access to the upstream repo. Saying so HERE, before the agent
          starts, is the difference between "it's working differently than promised" and a silent
          403 at the end. The wording comes from submitBlockedReason, the same source the persona
          uses, so the pane and the agent can't tell the user different stories. */}
      {submitNotice && (
        <div
          role="status"
          style={{
            flex: "0 0 auto",
            padding: "8px 14px",
            background: C.deepForest,
            borderBottom: `1px solid ${CHAT_USER_BUBBLE}`,
            color: C.muted,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {submitNotice}
        </div>
      )}

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
              // This pane kept its Composer, so a plain drag over a mouse-tracking TUI is
              // reclaimed as a text selection while that composer is open (roborev 46485-M).
              composerOverlay
              onStatus={(s) => setStatus(agentId, s)}
              onReady={() => setPtyReady(true)}
              // Pane reveal / agent change: incidental, so quiet — it must not re-aim dictation.
              onRequestFocus={() => focusQuietly(composerInputRef.current)}
              // The ⌘J chord: the user naming the box they want, so dictation goes with them. Said
              // OUTRIGHT here rather than inferred from the focus event downstream, because the
              // caret may not arrive until the un-minimize re-render — and by then the focus is
              // indistinguishable from the reveal effect's (roborev 54259).
              onUserRequestFocus={() => {
                useDictationStore.getState().setVoiceSurface("agent");
                focusQuietly(composerInputRef.current);
              }}
              focusRef={termFocusRef}
              apiRef={terminalApiRef}
            />
          </div>
          <Composer
            agentId={agentId}
            active={visible}
            // `preparing` (not `disabled`): a send before the PTY is up must QUEUE and flush on
            // ready, which is also what makes the dead-PTY restart below deliver its re-queued
            // prompt — the flush effect keys on this transition. `disabled` would hard-block the
            // send instead, stranding anything queued by a restart.
            preparing={!ptyReady}
            inputRef={composerInputRef}
            onSubmitPrompt={(t) => setLastPrompt(t)}
            // Same self-heal as AgentPane: a send that finds the PTY gone respawns the agent and
            // the queued prompt lands on the new PTY.
            onRestartAgent={() => {
              setPtyReady(false);
              terminalApiRef.current?.restart();
            }}
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
        borderRadius: 6,
        padding: "9px 18px",
        fontWeight: FONT_WEIGHT.semibold,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
