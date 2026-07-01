import { useEffect, useRef, useState } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import type { AgentTab, Project } from "../types";
import {
  prepareAgentWorkspace,
  installWorktreeGuard,
  installAgentHooks,
  assertWorkspaceIntegrity,
  prewarmProjectCaches,
} from "../services/worktree";
import { resolveDefaultBranch } from "../services/branchStatus";
import { useAiFeature } from "../services/aiGate";
import { checkClaude, claudeSessionInfo } from "../preflight";
import { buildClaudeExec, SHELL } from "../services/claudeSpawn";
import { shouldResetReusedSlotIdentity } from "../services/slotIdentity";
import { workerPersona, workerMission, WORKER_RESULT_RELPATH, parseWorkerResult, orchestrationPersona } from "../services/buildAgent";
import {
  startOrchestrationBridge,
  orchestratorMcpPaths,
  assembleBuildSpawn,
  stopOrchestrationBridge,
} from "../services/orchestrationLaunch";
import { useSettingsStore } from "../stores/settingsStore";
import { setPin, markExhausted, accountLabel, type Account, type Identity } from "../services/accountStore";
import { chooseAccountForAgent, invalidateAccountState } from "../services/accountSelection";
import { readWorkerResult } from "../pty";
import { maybeAutoName } from "../services/agentNaming";
import { judgeNeedsFollowup } from "../services/turnFollowup";
import { invoke } from "@tauri-apps/api/core";
import { HookStatusEngine, type HookEvent } from "../engine/hookEvents";
import { createStatusRouter, type StatusRouter } from "../engine/statusRouter";
import { watchHookEvents, type HookWatcher } from "../services/hookWatcher";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useScrollIntentStore, applyScrollIntent } from "../stores/scrollIntentStore";
import { PinnedPrompt } from "./PinnedPrompt";
import { Terminal, type TerminalApi } from "./Terminal";
import { Composer, type ComposerApi } from "./Composer";
import { Onboarding } from "./Onboarding";
import { ThinkPanel } from "./ThinkPanel";
import { paneVisibilityStyle } from "./paneVisibility";

type Phase = "preparing" | "ready" | "no-claude" | "error";

// macOS default login shell (shared SHELL from claudeSpawn): we launch `claude` through
// `zsh -l -c 'exec …'` so the agent (and the tools claude itself shells out to) inherit the user's
// real PATH/env — GUI apps otherwise get a minimal PATH and can't find node/git/etc.

/**
 * Build the argv for a shell agent spawn. Exported for unit testing of the injection-safety
 * invariant: the command must live in the positional-arg slot (args[4]) and must NEVER be
 * interpolated into the script string (args[2]).
 *
 *   shell -l -c 'eval "$1"; exec "$0" -l'  <shell-as-$0>  <cmd-as-$1>
 *
 * `eval "$1"` runs the command through the shell's argument-word expansion, not through a
 * string-embedded substitution, so trailing backslashes / unclosed quotes in the selection
 * can't escape into the surrounding script.
 */
export function buildShellSpawnArgs(shell: string, cmd: string): string[] {
  return ["-l", "-c", 'eval "$1"; exec "$0" -l', shell, cmd];
}

interface SpawnCmd {
  command: string;
  args: string[];
  cwd: string;
  // Whether this spawn resumes a prior Claude session (`claude --resume`) vs starts fresh. Passed to
  // the Terminal so its loading affordance reads "Resuming conversation…" vs "Starting Claude…".
  resuming: boolean;
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
  // Multi Claude Max account support: the accounts available (for the badge dropdown) and the one
  // THIS spawn runs under (its CLAUDE_CONFIG_DIR). `chosenAccountIdRef` mirrors the chosen id for the
  // rate-limit failover callback (which runs outside render). Empty accounts → no badge, default spawn.
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Real authenticated identity (email + org) per account id — the trustworthy badge label, read
  // from each account's own .claude.json oauthAccount (the nickname is only a secondary alias).
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [chosenAccount, setChosenAccount] = useState<Account | null>(null);
  const chosenAccountIdRef = useRef<string | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const setAgentWorktree = useProjectStore((s) => s.setAgentWorktree);
  const appendPrompt = useProjectStore((s) => s.appendPrompt);
  const setStatus = useRuntimeStore((s) => s.setStatus);
  // Pending "scroll to this prompt" for this agent (set by history-search navigation), consumed
  // once the terminal is the visible, ready pane.
  const scrollIntent = useScrollIntentStore((s) => s.intents[agent.id]);
  const consumeScrollIntent = useScrollIntentStore((s) => s.consume);
  // Tracks whether the last spawn was a fresh session (not a --continue resume). Used in the
  // worker exit handler to skip stale result re-reads on resumed sessions.
  const wasFreshLaunchRef = useRef(false);
  // Generation counter for the build-agent bridge lifecycle. Each prepare() run mints a unique
  // token (++prepareRunRef.current) before starting the bridge; the effect cleanup increments it
  // too. After startOrchestrationBridge resolves, the build branch compares its captured token
  // against the current counter — a mismatch means this run was superseded (unmount fired, or a
  // second prepare() started, e.g. StrictMode dev cycle or a Try-again while a prior await was
  // in flight) and the just-started bridge must be stopped immediately.
  // Replacing a plain boolean avoids the bug where the second prepare() reset the boolean before
  // the first cleanup's signal could be read.
  const prepareRunRef = useRef(0);
  // The composer's textarea — initial focus lands here when a tab opens.
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  // Imperative bridge to push text into the composer (pinned-prompt "Send to Composer").
  const composerApiRef = useRef<ComposerApi | null>(null);
  // The terminal's imperative focus(), so we can move focus into it when the composer
  // minimizes (or on ⌘J) without the user clicking the terminal.
  const termFocusRef = useRef<(() => void) | null>(null);
  const composerMinimized = useUiStore((s) => s.composerMinimized);
  // AI feature gates (Use AI Features menu). When the composer feature is off, we render the bare
  // terminal instead of the composer overlay; when auto-rename is off, we skip the naming call.
  const aiComposer = useAiFeature("composer");
  const aiAutoRename = useAiFeature("autoRename");
  // Imperative bridge to the terminal (e.g. arrow hand-off from the composer).
  const terminalApiRef = useRef<TerminalApi | null>(null);

  // Status routing: Claude Code's hook events are authoritative, but the screen scraper drives
  // until the first hook arrives (and for non-Claude programs that never emit one). The router
  // arbitrates; the watcher feeds the hook engine and activates the router on the first event.
  const routerRef = useRef<StatusRouter | null>(null);
  if (!routerRef.current) routerRef.current = createStatusRouter((s) => setStatus(agent.id, s));
  const hookWatcherRef = useRef<HookWatcher | null>(null);
  // Last response text we recorded for this agent, so a redundant Stop emission can't persist a
  // duplicate history row: each Stop re-reads the transcript's *last* assistant turn, so two Stops
  // for the same turn yield identical text. We dedup ONLY responses — replayed backlog is already
  // dropped by the watcher's skipExisting drain (below), and a real UserPromptSubmit fires once per
  // submission, so deduping prompts would wrongly swallow a genuine consecutive re-run of the same
  // prompt (roborev 8261ded / 10135).
  const lastResponseRef = useRef<string | undefined>(undefined);
  // Turn counter (tune-coloring): bumped on every UserPromptSubmit so the async followup judge can
  // tell whether the turn it was asked about is still the current one. A verdict that resolves after
  // the user already sent a new prompt (turn moved on) must NOT escalate the now-stale turn to red.
  const turnSeqRef = useRef(0);

  // Followup judge (tune-coloring): decide whether a finished turn is blocked on the user and, if
  // so, escalate the hook's gray `idle` to red `waiting` via the router. Reuses the same transcript
  // text already read for history capture. Best-effort: any failure leaves the turn gray. Gated by
  // the turn token so a verdict that resolves after the user moved on can't re-red a stale turn.
  const maybeJudgeFollowup = async (response: string, turn: number): Promise<void> => {
    try {
      const fresh = useProjectStore
        .getState()
        .projects.find((p) => p.id === project.id)
        ?.agents.find((a) => a.id === agent.id);
      // The "work at hand" the judge weighs a closeout-vs-new-work ask against: the prompt that
      // defined this agent's work, falling back to its name.
      const task = (fresh?.autoNameBasis ?? fresh?.name ?? agent.name ?? "").trim();
      const needs = await judgeNeedsFollowup({ task, response });
      if (needs && turnSeqRef.current === turn) {
        routerRef.current?.fromJudge("waiting");
      }
    } catch {
      // Judge is advisory — never let it disturb status handling.
    }
  };

  // History capture (): persist this Build agent's prompts and responses to the
  // searchable history store, reusing the hook pipeline rather than scraping the PTY. Only for
  // Claude-Code-backed agents (build/worker); think/shell never reach this code path but we guard
  // anyway. Fire-and-forget: a capture failure must NEVER break status handling, so every path is
  // wrapped and the store's record() already swallows its own errors.
  const captureHistoryFromHook = (ev: HookEvent) => {
    if (agent.kind !== "build" && agent.kind !== "worker") return;
    try {
      const record = useHistoryStore.getState().record;
      const base = () => ({
        id: crypto.randomUUID(),
        source: "build" as const,
        projectId: project.id,
        agentId: agent.id,
        projectName: project.name,
        agentName: agent.name,
        createdAt: Date.now(),
      });
      // A new user prompt opens a fresh turn — bump the counter the judge guards against (see
      // turnSeqRef). Done before the kind/text checks so EVERY submit advances the turn.
      if (ev.event === "UserPromptSubmit") turnSeqRef.current++;
      if (ev.event === "UserPromptSubmit" && ev.prompt && ev.prompt.trim()) {
        void record({ ...base(), kind: "prompt", text: ev.prompt });
      } else if (ev.event === "Stop" && ev.transcriptPath) {
        const path = ev.transcriptPath;
        // Snapshot the turn this Stop belongs to, so a judge verdict that resolves after the user
        // has moved on (new prompt → turnSeqRef bumped) is discarded rather than re-redding a turn
        // that's no longer current.
        const turn = turnSeqRef.current;
        // Read the last assistant turn out-of-band so the status update isn't blocked on disk I/O.
        void (async () => {
          try {
            const text = await invoke<string>("read_transcript_last_assistant", { path });
            if (!text || !text.trim()) return;
            if (text === lastResponseRef.current) return; // dup Stop for the same turn — already recorded
            lastResponseRef.current = text;
            void record({ ...base(), kind: "response", text });
            // Followup judge (tune-coloring): the hook fired Stop→idle (gray); decide whether this
            // finished turn is actually blocked on the user (a closeout ask) and, if so, escalate to
            // red. Best-effort and gated: only the freshest agent state, only the still-current turn.
            await maybeJudgeFollowup(text, turn);
          } catch {
            // best-effort capture — a missing/partial transcript just yields no response entry.
          }
        })();
      }
    } catch {
      // Defensive: nothing in capture may surface to the status path.
    }
  };

  const stopHookWatch = () => {
    hookWatcherRef.current?.stop();
    hookWatcherRef.current = null;
    // Hand status authority back to the scraper until the next run's first hook event, so a
    // restart doesn't stay frozen on the prior run's last hook status.
    routerRef.current?.reset();
  };

  const prepare = async () => {
    // Think agents are a Chief chat — no worktree, no PTY, nothing to prepare.
    if (agent.kind === "think") return;
    // Shell agents (Run-as-cmd) run a raw command in the project root, then drop into an
    // interactive login shell so output stays visible and follow-up commands work. No worktree,
    // no claude — spawn straight away.
    if (agent.kind === "shell") {
      // `SHELL` is defined at the top of this file. Pass the command as a positional arg ($1),
      // NEVER interpolated into the script, so a selection ending in a backslash/quote can't
      // swallow the trailing interactive shell. $0 is the shell path; `eval "$1"` runs the
      // command, then we exec a login shell.
      const cmd = agent.shellCommand ?? "";
      setSpawn({
        command: SHELL,
        args: buildShellSpawnArgs(SHELL, cmd),
        cwd: project.rootPath,
        resuming: false, // a raw command run, never a Claude session resume
      });
      setPhase("ready");
      return;
    }
    // Mint a generation token at the TOP of prepare() — before any await — so that a cleanup
    // increment that fires during *any* of the subsequent awaits (worktree prep, Claude check,
    // session detection, bridge start…) will be captured and detectable by the build branch's
    // post-bridge guard (myRun !== prepareRunRef.current). Placing it after the early non-async
    // returns (think/shell) means it only runs when we're about to do async work.
    const myRun = ++prepareRunRef.current;
    // Warm the spawn caches for this project (claude/node paths, account state, background origin
    // fetch) once per root — fire-and-forget, so later agents on this project skip the cold resolves.
    prewarmProjectCaches(project.rootPath);
    setPhase("preparing");
    setErrorMsg("");
    setPtyReady(false);
    // A re-prepare (Try again) restarts the agent from scratch — drop any prior hook watcher so
    // hooks for the new run start clean.
    stopHookWatch();
    try {
      // Kick off work that does NOT depend on the worktree right away, so it overlaps worktree
      // creation instead of running serially after it: whether Claude is installed, and which Max
      // account this job runs under. Both are cached and best-effort. We attach a no-op catch so an
      // earlier await throwing before these are consumed can't surface as an unhandled rejection —
      // the real `await claudeP` below still observes (and rethrows) a genuine failure.
      const claudeP = checkClaude();
      claudeP.catch(() => {});
      const accountP = chooseAccountForAgent(agent.id);
      // chooseAccountForAgent is documented never to throw, but guard symmetrically anyway so a
      // future regression there can't leak an unhandled rejection when an earlier await throws
      // before accountP is consumed. The real `await accountP` below still observes any result.
      accountP.catch(() => {});

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
      // NOTE: guard + hooks both read-modify-write the SAME `.claude/settings.local.json`, so they
      // MUST stay sequential — running them concurrently would race and clobber one hook (dropping
      // either the write-guard or the event emitter). The parallelism win comes from checkClaude /
      // account selection overlapping this whole block, not from splitting these two apart.
      try {
        await installWorktreeGuard(wt.path);
      } catch (e) {
        console.warn("guard install failed (relocation still protects):", e);
      }
      // Register Claude Code event hooks and start tailing the per-agent event log, so status is
      // driven by Claude's own lifecycle once it starts emitting. Best-effort: if this fails the
      // router simply stays on the screen-scraping fallback. Must run before the PTY spawns so the
      // hooks are in settings.local.json when `claude` reads it.
      try {
        const logPath = await installAgentHooks(wt.path);
        const router = routerRef.current!;
        const hookEngine = new HookStatusEngine({
          agentId: agent.id,
          onStatus: (s) => router.fromHook(s),
        });
        hookWatcherRef.current = watchHookEvents(
          logPath,
          (ev) => {
            router.activate(); // a real event arrived — hooks now own the status
            hookEngine.ingest(ev);
            // Persist prompts/responses to history (best-effort; never blocks/breaks status).
            captureHistoryFromHook(ev);
          },
          // Start at EOF: the log is keyed by worktree and accumulates prior runs + background
          // one-shot `claude` sessions. We want status from THIS spawn's session, which the engine
          // locks onto from the first event it sees — so the stale backlog must not be replayed.
          { skipExisting: true },
        );
      } catch (e) {
        console.warn("hook install failed; using screen-status fallback:", e);
      }
      await assertWorkspaceIntegrity(wt.path); // throws → caught below → error phase, no spawn
      // Poll branch status only after the workspace passed integrity — never for a sandbox we
      // are about to reject.
      void useRuntimeStore
        .getState()
        .pollBranchStatus(project.rootPath, project.id, agent.id, agentBase);
      const claude = await claudeP;
      if (!claude.installed || !claude.path) {
        setPhase("no-claude");
        return;
      }
      // Multi Claude Max: pick the account this job runs under (lowest-usage, honoring a manual pin).
      // No accounts configured → chosen is null → configDir undefined → spawn exactly as before.
      // Best-effort: chooseAccountForAgent never throws (it swallows IPC errors to empty state).
      const { chosen, state } = await accountP;
      setAccounts(state.accounts);
      setIdentities(state.identities);
      setChosenAccount(chosen);
      chosenAccountIdRef.current = chosen?.id ?? null;
      const configDir = chosen?.configDir;
      // Resume the prior conversation if this worktree already has one (the
      // worktree path is the session key). `--continue` errors in a directory
      // with no history, so only add it when a session exists. Resume is a
      // best-effort enhancement: if detection fails, fall back to a fresh
      // `claude` rather than blocking the agent from starting at all.
      // Pass the chosen account's config dir so resume detection looks under the SAME account the
      // spawn will use (CLAUDE_CONFIG_DIR is set on the child only — see the spec's integration
      // subtlety). Undefined configDir → Rust falls back to Sparkle's process env (prior behavior).
      // Distinguish a CONFIDENT "no session" from a probe that threw: both leave `resume` false (so
      // the spawn still falls back to a fresh `claude`), but only the confident case may trigger the
      // identity reset below — a transient failure must not wipe a historied slot (roborev 16238).
      //
      // hasSession + the resume session id come back in ONE round-trip (they share the same worktree
      // transcript scan). Resume by session id so Claude visibly REDRAWS the prior conversation on
      // reopen rather than `--continue`'s blank prompt (bead sparkle-wwg7); a null id → buildClaudeExec
      // falls back to `--continue`.
      let resume = false;
      let sessionDetectionConfident = true;
      let resumeSessionId: string | undefined = undefined;
      try {
        const info = await claudeSessionInfo(wt.path, configDir);
        resume = info.hasSession;
        resumeSessionId = resume ? (info.latestSessionId ?? undefined) : undefined;
      } catch {
        sessionDetectionConfident = false;
      }
      // Record whether this is a fresh launch so the worker exit handler can
      // distinguish a first-run (which should produce result.json) from a
      // reopened/resumed session (where result.json was already consumed earlier).
      // Known Plan-1 limitation: the ref tracks the LATEST prepare(), not a per-PTY
      // snapshot. If a worker tab is reopened (a second prepare() with resume=true)
      // while its first PTY is still running, that first PTY's exit will read the
      // newer `false` and skip the result log. This only loses a console line on an
      // improbable reopen-while-running race; per-result tracking is deferred to Plan 2.
      wasFreshLaunchRef.current = !resume;
      // Fresh start (confidently nothing to `claude --resume`) in this slot: if the worktree was
      // wiped+recreated and reused, the persisted auto-name and the sticky workflow progress belong
      // to the PRIOR occupant. Clear them so the new session doesn't come up wearing a stale identity
      // (the "named, working agent next to an empty terminal" report). Gated on a CONFIDENT
      // no-session result (never a probe failure), and no-op on a true first launch (nothing to
      // reset) and on a resume.
      if (shouldResetReusedSlotIdentity(resume, sessionDetectionConfident)) {
        useProjectStore.getState().resetAutoName(project.id, agent.id);
        useRuntimeStore.getState().resetProgress(agent.id);
      }
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
          configDir,
          resumeSessionId,
          // Workers run unattended in an isolated worktree: auto-approve every tool call so an
          // approval prompt can't silently deadlock the worker (and its waiting orchestrator).
          dangerouslySkipPermissions: true,
        });
      } else if (agent.kind === "build") {
        // Autonomous orchestrator launch (Plan 2c): start the per-build-agent bridge FIRST (claude's
        // MCP child connects to its socket at startup), resolve the node + bundled-server paths,
        // then spawn claude with the sparkle-orchestrator MCP server + orchestrator persona.
        //
        // `myRun` was minted at the top of prepare() (before all awaits) so any cleanup increment
        // during worktree-prep, Claude-check, or bridge-start is captured — the guard below fires
        // for unmounts that happen anywhere in the early async path, not just at the bridge await.
        const bridge = await startOrchestrationBridge(project.id, agent.id);
        // Guard: check our token — a mismatch means this run was superseded while we awaited.
        if (myRun !== prepareRunRef.current) {
          void stopOrchestrationBridge(agent.id).catch((e) =>
            console.warn("stopOrchestrationBridge (stale-run cleanup) failed", e),
          );
          return;
        }
        // Guard: if path resolution or assembly throws after the bridge has started, stop the bridge
        // before the outer prepare() catch surfaces the error phase — otherwise the socket + accept
        // thread linger until the pane eventually unmounts.
        try {
          const paths = await orchestratorMcpPaths();
          // Guard: check again after orchestratorMcpPaths — a cleanup increment during that
          // await means this run was superseded; stop the bridge we started and bail out.
          if (myRun !== prepareRunRef.current) {
            void stopOrchestrationBridge(agent.id).catch((e) =>
              console.warn("stopOrchestrationBridge (stale-run cleanup) failed", e),
            );
            return;
          }
          const persona = orchestrationPersona({
            ownBranch: wt.branch,
            maxConcurrentWorkers: useSettingsStore.getState().maxConcurrentWorkers,
          });
          setSpawn({
            ...assembleBuildSpawn({
              claudePath: claude.path,
              resume,
              cwd: wt.path,
              persona,
              bridge,
              paths,
              configDir,
              resumeSessionId,
            }),
            resuming: resume,
          });
          setPhase("ready");
          return;
        } catch (e) {
          // Bridge started but subsequent step failed — stop it before rethrowing so the outer
          // catch can set the error phase without leaving a zombie bridge behind.
          void stopOrchestrationBridge(agent.id).catch((stopErr) =>
            console.warn("stopOrchestrationBridge (error path cleanup) failed", stopErr),
          );
          throw e;
        }
      } else {
        exec = buildClaudeExec(claude.path, resume, { configDir, resumeSessionId });
      }
      setSpawn({
        command: SHELL,
        args: ["-l", "-c", exec],
        cwd: wt.path,
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
    // Stop tailing the event log when the pane unmounts (tab/agent closed).
    return () => {
      // Increment the generation counter to invalidate any in-flight prepare() run. If
      // startOrchestrationBridge resolves AFTER this cleanup runs, the build branch's token
      // comparison (myRun !== prepareRunRef.current) will detect the staleness and stop the bridge.
      prepareRunRef.current++;
      stopHookWatch();
      // A build agent owns an orchestration bridge for its lifetime — stop it on close so its
      // socket + accept thread don't linger. Best-effort: a missing bridge stop is a harmless no-op.
      if (agent.kind === "build") {
        void stopOrchestrationBridge(agent.id).catch((e) =>
          console.warn("stopOrchestrationBridge failed", e),
        );
      }
    };
    // Prepare once per agent (agent.id is stable for this component's life).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  // Manual override: pin this agent to a specific account. Updates the displayed badge immediately;
  // the pinned account actually takes effect on the NEXT spawn (a re-prepare / reopen) — we don't
  // restart a running agent out from under the user.
  const pickAccount = (acct: Account) => {
    setPin(agent.id, acct.id);
    setChosenAccount(acct);
    chosenAccountIdRef.current = acct.id;
    setAccountMenuOpen(false);
  };

  // Best-effort Phase-1 failover: a usage/rate-limit message in this agent's output flags the chosen
  // account exhausted so pickAccount steers the next job elsewhere. Fully isolated — any failure is
  // swallowed and never reaches terminal rendering.
  const handleRateLimit = (untilEpoch: number) => {
    const id = chosenAccountIdRef.current;
    if (!id) return;
    void markExhausted(id, untilEpoch)
      .then(() => invalidateAccountState())
      .catch((e) => console.warn("markExhausted failed (best-effort failover)", e));
  };

  // Focus follows the minimized state on the visible pane: minimized → terminal (so the user
  // can answer Claude's menus), restored → composer (so they type in the box). Drives both the
  // drag-to-minimize path and ⌘J. rAF lets the just-rendered surface mount/show first.
  useEffect(() => {
    if (!visible || !ptyReady) return;
    const raf = requestAnimationFrame(() => {
      // No composer (feature off) or it's minimized → focus the terminal so the user can type
      // straight into it; otherwise focus the composer textarea.
      if (!aiComposer || composerMinimized) termFocusRef.current?.();
      else composerInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [composerMinimized, visible, ptyReady, aiComposer]);

  // Consume a pending "scroll to this prompt" intent (set by history-search navigation) once this
  // agent's terminal is the visible, ready pane. Runs when the intent appears or the pane becomes
  // ready, so a click on an already-open agent and a click that first brings it forward both land.
  // Best-effort + intentionally silent on a miss: unlike the pinned-prompt Jump (a pure scroll
  // action that surfaces "Scrolled out"), a history click's primary act is navigating to the agent,
  // which succeeded — a marker that's scrolled out / from a prior session just doesn't scroll.
  useEffect(() => {
    applyScrollIntent({
      intent: scrollIntent,
      visible,
      ready: ptyReady,
      scrollToPrompt: (id) => terminalApiRef.current?.scrollToPrompt(id),
      consume: () => consumeScrollIntent(agent.id),
    });
  }, [scrollIntent, visible, ptyReady, agent.id, consumeScrollIntent]);

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
      {/* Think agents render a Chief chat instead of a Claude terminal. */}
      {agent.kind === "think" && (
        <ThinkPanel project={project} agentId={agent.id} visible={visible} />
      )}

      {agent.kind !== "think" && (
        <>
      <PinnedPrompt
        prompt={agent.lastPrompt}
        history={agent.promptHistory ?? []}
        // "Send to Composer" only makes sense when the composer is mounted (AI feature on).
        onSendToComposer={
          aiComposer ? (text) => composerApiRef.current?.insertPrompt(text) : undefined
        }
        // Jump the terminal back to where a prompt was sent. "missing" → the row reports it's
        // scrolled out of this session (marker trimmed or from a prior session).
        onJumpToPrompt={(id) => terminalApiRef.current?.scrollToPrompt(id) ?? "missing"}
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
          <div
            style={{
              position: "absolute",
              inset: 0,
              padding: 6,
              boxSizing: "border-box",
            }}
          >
            <Terminal
              agentId={agent.id}
              projectId={project.id}
              projectRootPath={project.rootPath}
              command={spawn.command}
              args={spawn.args}
              cwd={spawn.cwd}
              resuming={spawn.resuming}
              active={visible}
              onStatus={(s) => routerRef.current!.fromScreen(s)}
              onReady={() => setPtyReady(true)}
              onRateLimit={handleRateLimit}
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
          {/* AI-enhanced composer (feature-gated). Off → no overlay: the user types straight into
              the terminal beneath (and photo-drop + Send go away with it).
              NOTE: auto-rename (maybeAutoName below) is intentionally coupled to the composer — the
              only "a prompt was submitted" hook is the composer's onSubmitPrompt. With the composer
              off, the user submits via raw terminal keystrokes (no prompt boundary to summarize), so
              auto-rename can't run even if its own flag is on. That's an accepted coupling, not a bug. */}
          {aiComposer && (
            <Composer
              agentId={agent.id}
              active={visible}
              disabled={!ptyReady}
              inputRef={composerInputRef}
              apiRef={composerApiRef}
              onArrowOverflow={(dir) => terminalApiRef.current?.arrowFromComposer(dir)}
              onEnterOverflow={() => terminalApiRef.current?.enterFromComposer()}
              onSubmitPrompt={(display, namingBasis) => {
                // Record the DISPLAY string (typed text + 📄/📷/📎 markers) for the pinned header +
                // history dropdown, and drop a terminal marker under the same id so "jump to this
                // prompt" (dropdown + history search) can scroll back here later this session.
                const promptId = appendPrompt(project.id, agent.id, display);
                terminalApiRef.current?.markPrompt(promptId);
                // Fire-and-forget: summarize the work into a short name (first prompt, or when
                // the work shifts). No-ops if the name is pinned or no API key is configured.
                // Gated on the auto-rename AI feature. Name from the user's TYPED text only —
                // never the attachment emoji-count markers — and skip entirely when an
                // attachments-only send leaves the basis empty (so the naming model never sees
                // "📷 1 image" and replies with conversational refusal text).
                const basis = namingBasis.trim();
                if (aiAutoRename && basis) void maybeAutoName(project.id, agent.id, basis);
              }}
            />
          )}
          {/* Account badge: which Claude account this agent runs under, click to pin a different
              one. Only shown once at least one account exists (multi Claude Max support). */}
          {accounts.length > 0 && chosenAccount && (
            <AccountBadge
              accounts={accounts}
              identities={identities}
              chosen={chosenAccount}
              open={accountMenuOpen}
              onToggle={() => setAccountMenuOpen((v) => !v)}
              onPick={pickAccount}
            />
          )}
        </div>
      )}
        </>
      )}
    </div>
  );
}

/**
 * Small pill in the pane's top-right showing the Claude account this agent runs under. Click to
 * open a dropdown of all accounts and pin a different one for this agent (takes effect next spawn).
 * The pinned/active account is marked. Styling mirrors the app's other dark popovers (TopBar menus).
 */
function AccountBadge({
  accounts,
  identities,
  chosen,
  open,
  onToggle,
  onPick,
}: {
  accounts: Account[];
  identities: Identity[];
  chosen: Account;
  open: boolean;
  onToggle: () => void;
  onPick: (a: Account) => void;
}) {
  const identityFor = (id: string) => identities.find((i) => i.id === id);
  const chosenIdentity = identityFor(chosen.id);
  // The trustworthy label is the REAL logged-in email; the nickname is only a secondary alias.
  const chosenReal = accountLabel(chosen, chosenIdentity);
  const chosenOrg = chosenIdentity?.organization;
  // Tooltip surfaces the full identity: email, org, and nickname alias when it differs from email.
  const tooltip = [
    chosenIdentity?.email
      ? `Claude account: ${chosenIdentity.email}`
      : `Claude account: ${chosen.nickname} (not signed in)`,
    chosenOrg ? `Organization: ${chosenOrg}` : null,
    chosenIdentity?.email && chosen.nickname !== chosenIdentity.email ? `Nickname: ${chosen.nickname}` : null,
    "click to change",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div style={{ position: "absolute", top: 12, right: 12, zIndex: 20 }}>
      <button
        type="button"
        data-hint="account"
        title={tooltip}
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: C.deepForest,
          border: `1px solid ${C.muted}`,
          borderRadius: 6,
          color: C.cream,
          fontFamily: '"IBM Plex Sans", sans-serif',
          fontSize: 11,
          padding: "3px 8px",
          cursor: "pointer",
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 3, background: C.teal }} />
        <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {chosenReal}
        </span>
        <span style={{ color: C.muted }}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={onToggle} style={{ position: "fixed", inset: 0, zIndex: 19 }} />
          <div
            style={{
              position: "absolute",
              top: "100%",
              right: 0,
              marginTop: 4,
              minWidth: 180,
              background: C.deepForest,
              border: `1px solid ${C.forest}`,
              borderRadius: 8,
              boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
              padding: 6,
              zIndex: 21,
            }}
          >
            {accounts.map((a) => {
              const active = a.id === chosen.id;
              const identity = identityFor(a.id);
              // Primary line = real logged-in email (or nickname when not signed in); the nickname
              // becomes a secondary alias line whenever it differs from the email.
              const primary = accountLabel(a, identity);
              const alias = identity?.email && a.nickname !== identity.email ? a.nickname : null;
              return (
                <div
                  key={a.id}
                  onClick={() => onPick(a)}
                  title={identity?.organization ? `${a.configDir}\nOrganization: ${identity.organization}` : a.configDir}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontFamily: '"IBM Plex Sans", sans-serif',
                    fontSize: 12,
                    color: C.cream,
                    background: active ? C.forest : "transparent",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      flexShrink: 0,
                      background: active ? C.teal : "transparent",
                      border: active ? "none" : `1px solid ${C.muted}`,
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                    <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {primary}
                    </span>
                    {alias && (
                      <span style={{ display: "block", color: C.muted, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {alias}
                      </span>
                    )}
                    {!identity?.email && (
                      <span style={{ display: "block", color: C.muted, fontSize: 10 }}>not signed in</span>
                    )}
                  </span>
                  {a.isDefault && <span style={{ color: C.muted, fontSize: 10, flexShrink: 0 }}>default</span>}
                </div>
              );
            })}
          </div>
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
