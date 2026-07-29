import { memo, useCallback, useEffect, useRef, useState } from "react";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { useResolvedTheme } from "../theme/theme";
import {
  TERM_HAIRLINE,
  TERM_PLANE,
  TERM_RADIUS,
  TERM_TYPE,
  TERM_UI,
  termInk,
  termMuted,
} from "./terminalChrome";
import type { AgentTab, Project } from "../types";
import {
  prepareAgentWorkspace,
  installWorktreeGuard,
  installAgentHooks,
  assertWorkspaceIntegrity,
  prewarmProjectCaches,
  warmWorktreePool,
} from "../services/worktree";
import { reconcileDefaultBranch } from "../services/branchStatus";
import { recordTrialSend } from "../services/trialMeter";
import { checkClaude, claudeSessionInfo } from "../preflight";
import { buildClaudeExec, buildControlMcpConfig, SHELL } from "../services/claudeSpawn";
import { shouldResetReusedSlotIdentity } from "../services/slotIdentity";
import { workerPersona, workerMission, WORKER_RESULT_RELPATH, parseWorkerResult, orchestrationPersona, sparkleControlProtocol } from "../services/buildAgent";
import {
  startOrchestrationBridge,
  orchestratorMcpPaths,
  assembleBuildSpawn,
  stopOrchestrationBridge,
  startControlBridge,
  controlMcpPaths,
  type BridgeInfo,
  type McpPaths,
} from "../services/orchestrationLaunch";
import { purgeBuildAgent } from "../services/orchestrationListener";
import { useSettingsStore, enforcedWorkerCap } from "../stores/settingsStore";
import { setPin, accountLabel, type Account, type Identity } from "../services/accountStore";
import {
  registerPaneRestart,
  unregisterPaneRestart,
  registerPaneAccount,
  unregisterPaneAccount,
} from "../services/paneControl";
import { chooseAccountForAgent } from "../services/accountSelection";
import { readWorkerResult } from "../pty";
import { judgeNeedsFollowup } from "../services/turnFollowup";
import { noteAgentTranscriptPath } from "../services/conciergeTools/terminal";
import { invoke } from "@tauri-apps/api/core";
import { HookStatusEngine, createHookEventHandler, type HookEvent } from "../engine/hookEvents";
import { createStatusRouter, type StatusRouter } from "../engine/statusRouter";
import { noteHooksDead, noteHooksLive } from "../engine/turnEndAuthority";
import { log } from "../logger";
import { watchHookEvents, type HookWatcher } from "../services/hookWatcher";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useScrollIntentStore, applyScrollIntent } from "../stores/scrollIntentStore";
import { PinnedPrompt } from "./PinnedPrompt";
import { composerPrompts } from "./promptHistory";
import { Terminal, type TerminalApi } from "./Terminal";
import { registerPromptMarker } from "../services/terminalMarkers";
import { abandonPendingSends, flushPendingSends } from "../services/conciergeDispatch";
import { setPaneFailed, setPaneReady, unregisterPane } from "../services/paneReadiness";
import { isTypingInProgress } from "../engine/focusGuard";
import { TerminalDropOverlay } from "./TerminalDropOverlay";
import { TerminalDropPill } from "./TerminalDropPill";
import { useTerminalDrop } from "../hooks/useTerminalDrop";
import { Onboarding } from "./Onboarding";
import { paneVisibilityStyle } from "./paneVisibility";
import { TERMINAL_STAGE_PADDING } from "./terminalStageAnchor";
import { useTerminalOverlayStore } from "../stores/terminalOverlayStore";
import { perfRender, perfMark, perfEnd, perfCancel } from "../perfTrace";

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

/**
 * Park a Stop event's transcript path where the concierge's terminal read chain can find it.
 *
 * THIS COMPONENT IS THE ONLY PLACE THE PATH IS EVER KNOWN. The Stop hook event carries it, the
 * capture handler below reads the last assistant turn out of it, and it was then dropped on the
 * floor — so `services/conciergeTools/terminal`'s tier (d) had no path for any agent and its
 * four-tier read chain silently degraded to three. That module deliberately refuses to GUESS a path
 * (a fabricated `~/.claude/projects/<slug>/<id>.jsonl` fails confusingly, and slug derivation is
 * exactly the kind of guess a read chain shouldn't make), and it no longer accepts one as a caller
 * argument either — a tool argument that names a file to read is an arbitrary-file read whose
 * contents land in an LLM context. The registry is the seam between those two positions, and this is
 * its one writer.
 *
 * Takes the whole event and makes the whole decision, and is wired as `noteTranscript` — a REQUIRED
 * field of `HookEventHandlerDeps` — rather than as a line inside the capture closure below. That
 * placement is the point: as a required dep, dropping the hand-off is a compile error, whereas a
 * deleted line inside a closure broke nothing any test could see. It also puts the call behind the
 * handler's session gate (a background `claude` sharing this worktree's log must not register ITS
 * transcript against this agent) and ahead of `captureHistory`, so the registry write doesn't ride
 * on the history store resolving.
 *
 * NOTHING CLEARS THE REGISTRY TODAY, and that is a considered position rather than an oversight.
 * The obvious hook — the pane's unmount cleanup — is wrong twice over: it fires on a mere project
 * switch, and tier (d) exists precisely to answer for agents whose pane ISN'T mounted, so clearing
 * there would drop the entry exactly when it becomes useful. There is no other agent-close seam this
 * component can see (`purgeBuildAgent` runs from that same unmount path). The cost of leaving it is
 * one short string per agent id opened this process; a stale entry is not a hazard either, since
 * reading a closed agent's final transcript is an honest answer. `forgetAgentTranscriptPath` exists
 * for a caller that genuinely knows an agent is gone — there isn't one yet.
 */
export function noteTranscriptFromStop(agentId: string, ev: HookEvent): void {
  if (ev.event !== "Stop") return;
  const path = ev.transcriptPath?.trim();
  if (!path) return;
  noteAgentTranscriptPath(agentId, path);
}

/** Settle a pane's "switch:<id>" waterfall against its visibility, returning the effect cleanup.
 *
 *  `selectAgent` starts the trace on every selection, but a pane only turns visible when it's the
 *  selected agent AND no overlay (Tasks board / Sparkle pane) is covering the panes. So a selection
 *  made *under* an overlay never paints:
 *   - visible → end the trace after the next paint, recording click→pane-visible latency.
 *   - not visible → ABANDON it. Leaving it open means the eventual overlay dismissal, seconds or
 *     minutes later, ends it and reports that idle dwell as switch latency — a garbage outlier in
 *     the metric, and until then a phantom "in-flight interaction" other perf instruments can see.
 *     Dropping it keeps the metric honest: it measures the switches that actually painted. */
export function settleSwitchTrace(key: string, visible: boolean): (() => void) | undefined {
  if (!visible) {
    perfCancel(key);
    return undefined;
  }
  const raf = requestAnimationFrame(() => perfEnd(key, "painted"));
  return () => cancelAnimationFrame(raf);
}

interface SpawnCmd {
  command: string;
  args: string[];
  cwd: string;
  // Whether this spawn resumes a prior Claude session (`claude --resume`) vs starts fresh. Passed to
  // the Terminal so its loading affordance reads "Resuming conversation…" vs "Starting Claude…".
  resuming: boolean;
}

function AgentPaneInner({
  project,
  agent,
  visible,
  calm = false,
}: {
  project: Project;
  agent: AgentTab;
  visible: boolean;
  // PRD §3 "calm": this pane's agent has nothing for you (P2), so its terminal text recedes to one
  // gray. Only ever true for the VISIBLE pane — a background pane's colors are nobody's business,
  // and re-theming it would clear its WebGL atlas for a screen no one is looking at.
  calm?: boolean;
}) {
  // Re-render counter (perfTrace): with many panes open, a background pane that re-renders on every
  // unrelated store write is the render-thrash fingerprint — `grep 'perf.*render AgentPane'` and watch
  // the count. Called every render (cheap Map bump + debug line).
  perfRender("AgentPane", agent.id, { visible });

  // The terminal plane's ink register. The plane itself is a CSS var and needs no React, but
  // `termInk`/`termMuted` have no variable to ride (see terminalChrome), so a theme flip re-renders
  // this pane. That is a RE-RENDER ONLY: the Terminal below keeps its element type and its
  // account-derived key across the flip, so React reconciles rather than remounting — which matters
  // because a Terminal unmount kills its PTY. AgentPane.blueprint.test.tsx pins that.
  const resolvedTheme = useResolvedTheme();

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
  // Per-launch owner token for THIS agent's orchestration bridge (). Minted fresh each
  // prepare() run and passed to start/stop so a stale run's teardown (a sub-second close-reopen, or
  // a superseded prepare()) can only stop the bridge instance IT owns — never a newer run's bridge.
  const bridgeLaunchTokenRef = useRef<string>("");
  // The terminal's imperative focus(), so the pane can put the caret in the terminal without the
  // user clicking it (this is now the ONLY place a user types into an agent directly — the
  // concierge box is the app's composer).
  const termFocusRef = useRef<(() => void) | null>(null);
  // Imperative bridge to the terminal (marker drops, arrow/enter hand-offs, scroll-to-prompt).
  const terminalApiRef = useRef<TerminalApi | null>(null);
  // The terminal pane box, so the drag-vision hint pill can anchor just above it.
  const terminalStageRef = useRef<HTMLDivElement>(null);
  // …and so the concierge's recommended-action pill can render INSIDE it. The pill is wired to the
  // concierge (delivery queue, failure relay) but belongs on the agent it acts on, so it portals in
  // here; publishing the node is how the two subtrees meet. A callback ref rather than a plain one
  // because the store write has to happen on attach/detach, not on some later render — and it must
  // clear on detach, or a closed agent's stale node would keep a portal alive on a dead element.
  const setTerminalStage = useCallback(
    (el: HTMLDivElement | null) => {
      terminalStageRef.current = el;
      useTerminalOverlayStore.getState().setStage(agent.id, el);
    },
    [agent.id],
  );
  // Drop files on this terminal and their paths are pasted straight into it, at the CLI's current
  // input line — a drop lands where it was dropped (useTerminalDrop's header covers why it used to
  // land in the Sparkle box instead). The paste is followed by the caret, so the user can type the
  // ask onto the text they can see waiting there; nothing is submitted until they press Enter.
  //
  // Only the VISIBLE pane listens. The webview drag event is window-global and every visited pane
  // stays mounted and stacked in the same stage, so `visible` is the ONLY thing that can name which
  // agent a drop belongs to — see useTerminalDrop's header.
  const focusTerminalForDrop = useCallback(() => termFocusRef.current?.(), []);
  const terminalDrop = useTerminalDrop(visible, agent.id, focusTerminalForDrop);

  // Publish this agent's "mark a prompt at the current terminal row" capability while its pane is
  // mounted, so the concierge dispatch path can drop the jump-to-prompt marker the composer used to
  // drop inline (see services/terminalMarkers + conciergeDispatch). Registered per agent id;
  // unregistered on unmount so a closed pane can't be marked.
  useEffect(
    () => registerPromptMarker(agent.id, (promptId) => terminalApiRef.current?.markPrompt(promptId)),
    [agent.id],
  );

  // Status routing: Claude Code's hook events are authoritative, but the screen scraper drives
  // until the first hook arrives (and for non-Claude programs that never emit one). The router
  // arbitrates; the watcher feeds the hook engine and activates the router on the first event.
  const routerRef = useRef<StatusRouter | null>(null);
  if (!routerRef.current)
    routerRef.current = createStatusRouter(
      (s) => setStatus(agent.id, s),
      undefined,
      // Every status change, with the input that drove it, on ONE greppable line. A day of false
      // "needs you" alarms previously left no trace in the log at all — `blocked`, `needs_you` and
      // `attention_screen` all returned zero hits — so the only diagnosis available was watching the
      // UI. `info` (not `debug`) deliberately: debug forwarding is off in production builds, and this
      // is exactly the trail a support capture needs. It fires only on a real change, so a row that
      // sits still costs nothing.
      (t) => log.info("agent-status", "transition", { agentId: agent.id, agentName: agent.name, ...t }),
      // The stream just died; it witnesses nothing from here. Recovery is automatic — the next
      // main-session event calls activate(), which re-asserts noteHooksLive.
      () => {
        log.info("agent-status", "hook stream declared dead", { agentId: agent.id });
        noteHooksDead(agent.id);
      },
    );
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
      // NO `screen` ARGUMENT (roborev 54774). A picker short-circuit was wired here and removed:
      //   • It could not fire in the case it was written for. This runs only from the `Stop`-hook
      //     branch, and the reported bug is a picker rendered MID-turn, where the last hook is
      //     `PreToolUse` → `working` and no `Stop` ever arrives.
      //   • The one case it COULD reach — a menu still on screen when `Stop` fires — is already
      //     handled by `statusRouter`'s `screenAwaits()` escalation (statusRouter.ts:109).
      //   • And it was fed `getAgentScrollback`, which is scrollback HISTORY, not the viewport. A
      //     dialog ANSWERED earlier in the same turn still reads as live once its frame scrolls out
      //     of the viewport (Ink's redraw can never erase it there), so it pinned `waiting` and held
      //     the row red through the whole idle period — a false RED, the direction that trains a
      //     human to ignore red.
      // The real fix is to escalate on a mid-turn signal inside `resolve()` using the VIEWPORT
      // reader (`snapshotScreen`, already what the status engine uses), which is not reachable from
      // here today — tracked as its own bead rather than approximated with history.
      // Metering-only project arg: attributes the judge's debit to this agent's project in Credits.
      const outcome = await judgeNeedsFollowup({ task, response, project: project.name });
      const stale = turnSeqRef.current !== turn;
      log.info("agent-status", "followup judge outcome", {
        agentId: agent.id,
        verdict: outcome.verdict,
        signal: outcome.verdict === "unknown" ? outcome.signal : undefined,
        applied: outcome.verdict === "followup" && !stale,
        stale,
      });
      // ONLY a judge that actually RAN and said FOLLOWUP may red a row. `unknown` means the judge
      // could not run (backend down / out of credits / offline): there is no verdict, so we assert
      // none and leave the hook's own gray `idle` standing. Painting red off an unavailable judge is
      // what produced the 2026-07-28 false-alarm storm — see turnFollowup's header.
      if (outcome.verdict === "followup" && !stale) {
        routerRef.current?.fromJudge("waiting");
      }
      // The neutral middle state. A turn we could NOT judge keeps a marker so the ask isn't silently
      // lost to gray; anything we COULD judge clears it, because we now have a real answer. Skipped
      // entirely when the turn has moved on — the marker would be about work the user already left.
      if (!stale) {
        const rt = useRuntimeStore.getState();
        if (outcome.verdict === "unknown") rt.setUnjudgedAsk(agent.id, outcome.signal);
        else rt.clearUnjudgedAsk(agent.id);
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
      if (ev.event === "UserPromptSubmit") {
        turnSeqRef.current++;
        // A new turn makes any unjudged-ask marker moot: the user has spoken, so whatever the last
        // turn may have been asking is now answered or abandoned either way.
        useRuntimeStore.getState().clearUnjudgedAsk(agent.id);
      }
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
    // Cloud agents run entirely server-side (in a Sparkle-provisioned E2B sandbox); the session
    // already exists there. The desktop's job is to ATTACH, not to spawn — so gate the ENTIRE local
    // spawn policy (project prewarm/git-init, worktree claim, Claude preflight, account selection,
    // orchestration bridge) on runtime === "local". A cloud agent thus never touches the local
    // filesystem or spawns a local PTY: Terminal mounts with the cloud transport (getTransport →
    // CloudTransport) and attaches over the relay. command/args/cwd here are placeholders the cloud
    // transport ignores. (Creating the server session + re-attach reconciliation is W5's scope.)
    if (agent.runtime === "cloud") {
      setSpawn({ command: SHELL, args: [], cwd: project.rootPath, resuming: false });
      setPhase("ready");
      return;
    }
    // Prepare the project ONCE per root BEFORE the kind-specific early returns: warm the spawn
    // caches and — critically — ensure the folder is a git repo. Shell agents run in-place in the
    // project root with no worktree, so without this an entire project could be built in a folder
    // that never becomes a git repo and is unrecoverable if the app loses the project (the
    // hazel-eco case). Idempotent + fire-and-forget (never throws, never blocks).
    prewarmProjectCaches(project.rootPath);
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
    // Mint this run's bridge owner token (). Stored in a ref so the effect-cleanup stop
    // (which runs outside prepare) presents the same token this run started the bridge with.
    const launchToken = crypto.randomUUID();
    bridgeLaunchTokenRef.current = launchToken;
    // (Spawn caches + repo git-init were already warmed at the top of prepare(), before the
    // think/shell returns, so in-place sessions git-init too — see prewarmProjectCaches above.)
    // Warm the pre-warmed worktree pool for this project (off the main thread) so a subsequent agent
    // spawn can CLAIM a ready worktree instead of paying `git worktree add` on the critical path.
    // Fire-and-forget + self-throttling (a no-op once the pool is full or the feature is disabled).
    // Rust resolves the base itself, so an as-yet-unresolved defaultBranch is fine here.
    void warmWorktreePool(project.rootPath, project.id, project.defaultBranch ?? "").catch(() => {});
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

      // Resolve/heal the project's integration branch, then base this agent off it. Two paths keep
      // the common open off the git hot path:
      //  - Unset (first open / legacy project): detect + persist BEFORE spawn, awaited — same single
      //    round-trip the code always did here, so no added latency for the common case.
      //  - Already recorded: heal any drift in the BACKGROUND (non-gating). A persisted default that
      //    drifted out of the repo (renamed main→master, base deleted, re-cloned) is corrected in the
      //    store for the UI and future opens; the Rust effective_base fallback still fixes THIS spawn's
      //    actual cut if the value is stale, so nothing needs to block on the reconcile.
      // Normalize a possibly-empty result the same way the store does, so the worktree/poll layers
      // never see a value the store guard would have nulled.
      let base = project.defaultBranch;
      if (!base) {
        const resolved = (await reconcileDefaultBranch(project.rootPath, "")).trim();
        base = resolved || null;
        if (base) useProjectStore.getState().setDefaultBranch(project.id, base);
      } else {
        const recorded = base;
        void reconcileDefaultBranch(project.rootPath, recorded)
          .then((r) => {
            const healed = r.trim();
            if (healed && healed !== recorded) {
              useProjectStore.getState().setDefaultBranch(project.id, healed);
            }
          })
          .catch(() => {});
      }
      // An agent created before defaultBranch existed has a null baseBranch — backfill it.
      // An empty agentBase is tolerated by the Rust effective_base fallback.
      const agentBase = agent.baseBranch ?? base ?? "";
      const wt = await prepareAgentWorkspace(project.rootPath, project.id, agent.id, agentBase);
      perfMark(agent.id, "worktree ready");
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
        const logPath = await installAgentHooks(wt.path, project.rootPath);
        const router = routerRef.current!;
        const hookEngine = new HookStatusEngine({
          agentId: agent.id,
          onStatus: (s) => router.fromHook(s),
        });
        hookWatcherRef.current = watchHookEvents(
          logPath,
          // One session gate in front of every consumer — status, liveness, and history. See
          // createHookEventHandler for why the ordering is load-bearing; it lives in engine/ so
          // that ordering is tested directly rather than inline here.
          createHookEventHandler({
            engine: hookEngine,
            activate: () => {
              router.activate();
              // A real hook event means `Stop` will witness the end of every turn from here, so this
              // agent's settled statuses are facts rather than time-heuristic guesses. Destructive
              // gates read that distinction (engine/turnEndAuthority) instead of the `blocked` status
              // that used to stand in for it.
              noteHooksLive(agent.id);
            },
            captureHistory: captureHistoryFromHook,
            // Tier (d) of the concierge's read chain. A REQUIRED dep, so this hand-off cannot be
            // dropped without a compile error — see HookEventHandlerDeps.noteTranscript.
            noteTranscript: (ev) => noteTranscriptFromStop(agent.id, ev),
          }),
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
      perfMark(agent.id, "claude checked");
      if (!claude.installed || !claude.path) {
        setPhase("no-claude");
        return;
      }
      // Multi Claude Max: pick the account this job runs under (lowest-usage, honoring a manual pin).
      // No accounts configured → chosen is null → configDir undefined → spawn exactly as before.
      // Best-effort: chooseAccountForAgent never throws (it swallows IPC errors to empty state).
      const { chosen, state } = await accountP;
      perfMark(agent.id, "account resolved");
      setAccounts(state.accounts);
      setIdentities(state.identities);
      setChosenAccount(chosen);
      chosenAccountIdRef.current = chosen?.id ?? null;
      // Publish the account this PTY will actually run under, so a global switch can tell which
      // agents have to move. Not derivable from the pin map — most agents auto-pick and have no pin.
      if (chosen) registerPaneAccount(agent.id, chosen.id);
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
      perfMark(agent.id, "session detected");
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
      // App-level sparkle-control MCP wiring, injected into EVERY agent kind's claude spawn so any
      // in-app Claude can drive the Sparkle UI (rename itself, narrate its activity, read state).
      // start_control_bridge is an idempotent singleton — controlListener already started it at boot;
      // we call it again here only to fetch this spawn's socket+token. Best-effort: a control-bridge
      // failure must NEVER block the agent from starting, so on any error we spawn WITHOUT the
      // control tools this once (the agent still runs; it just can't self-report until next launch).
      // SPARKLE_AGENT_ID = agent.id, the anti-spoofing caller identity for per-agent ops.
      let control: { bridge: BridgeInfo; paths: McpPaths; agentId: string } | undefined;
      try {
        const [controlBridge, controlPaths] = await Promise.all([
          startControlBridge(),
          controlMcpPaths(),
        ]);
        control = { bridge: controlBridge, paths: controlPaths, agentId: agent.id };
      } catch (e) {
        console.warn("[control] sparkle-control MCP wiring unavailable; spawning without it", e);
      }
      // For non-Build kinds (worker / generic) we ADD the control server WITHOUT --strict-mcp-config,
      // so the user's own global MCP servers still load alongside it. (Build agents go through
      // assembleBuildSpawn, which is strict and merges control into the orchestrator config.)
      const controlMcpConfig = control
        ? buildControlMcpConfig({
            nodePath: control.paths.nodePath,
            serverPath: control.paths.serverPath,
            socketPath: control.bridge.socketPath,
            token: control.bridge.token,
            agentId: control.agentId,
          })
        : undefined;
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
          appendSystemPrompt: workerPersona({
            parentBranch,
            resultPath,
            guardrails: useSettingsStore.getState().guardrailsEnabled,
          }),
          initialPrompt: workerMission(agent.task ?? "", agent.id),
          configDir,
          resumeSessionId,
          model: agent.model,
          // Add the app-level sparkle-control MCP (undefined when the bridge was unavailable → no
          // flag). No strictMcpConfig, so the worker keeps the user's own global MCP servers too.
          mcpConfig: controlMcpConfig,
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
        const bridge = await startOrchestrationBridge(project.id, agent.id, launchToken);
        perfMark(agent.id, "bridge started");
        // Guard: check our token — a mismatch means this run was superseded while we awaited.
        if (myRun !== prepareRunRef.current) {
          void stopOrchestrationBridge(agent.id, launchToken).catch((e) =>
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
            void stopOrchestrationBridge(agent.id, launchToken).catch((e) =>
              console.warn("stopOrchestrationBridge (stale-run cleanup) failed", e),
            );
            return;
          }
          const persona = orchestrationPersona({
            ownBranch: wt.branch,
            // The ENFORCED cap, not the raw configured one — the persona is told how many
            // workers it may spawn, and the spawn gate silently queues anything past this. Telling
            // it a bigger number just makes it spawn into a queue and wait (sparkle-01xv).
            maxConcurrentWorkers: enforcedWorkerCap(useSettingsStore.getState()),
            guardrails: useSettingsStore.getState().guardrailsEnabled,
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
              model: agent.model,
              // Spawn-time plan-mode request. THIS is the branch build agents take, and build agents
              // are the only ones that can carry the field — threading it only into the generic
              // branch below meant the flag was never emitted at all (roborev 55057).
              permissionMode: agent.permissionMode,
              // Merge the app-level sparkle-control MCP into the SAME --mcp-config as the orchestrator
              // server (never dropping the orchestrator), so a Build agent both fans out workers AND
              // drives its own UI. Omitted when the control bridge was unavailable this spawn.
              control,
            }),
            resuming: resume,
          });
          perfMark(agent.id, "spawn assembled (build)");
          setPhase("ready");
          return;
        } catch (e) {
          // Bridge started but subsequent step failed — stop it before rethrowing so the outer
          // catch can set the error phase without leaving a zombie bridge behind.
          void stopOrchestrationBridge(agent.id, launchToken).catch((stopErr) =>
            console.warn("stopOrchestrationBridge (error path cleanup) failed", stopErr),
          );
          throw e;
        }
      } else {
        // Generic (non-Build/worker) claude agent: inject the sparkle-control MCP + its discovery
        // snippet so it too can drive the UI. No strictMcpConfig → the user's global MCP still loads.
        // Only append the "you can drive the UI" prose when the control MCP actually loaded — if the
        // bridge was unavailable this spawn (controlMcpConfig undefined), advertising tools that
        // aren't there just yields confusing "tool not found" attempts.
        exec = buildClaudeExec(claude.path, resume, {
          configDir,
          resumeSessionId,
          model: agent.model,
          // Spawn-time plan-mode request. buildClaudeExec applies it only when NOT resuming, so an
          // agent the human took out of plan mode with shift+tab is not dragged back into it on
          // every relaunch.
          permissionMode: agent.permissionMode,
          mcpConfig: controlMcpConfig,
          appendSystemPrompt: controlMcpConfig ? sparkleControlProtocol() : undefined,
        });
      }
      setSpawn({
        command: SHELL,
        args: ["-l", "-c", exec],
        cwd: wt.path,
        resuming: resume,
      });
      perfMark(agent.id, "spawn assembled");
      setPhase("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  useEffect(() => {
    // Spawn waterfall: the click (useSpawnBuildAgent) started the "spawn" trace for this id; record
    // how long from click to this pane actually mounting + prepare() kicking off.
    perfMark(agent.id, "pane mount");
    void prepare();
    // Stop tailing the event log when the pane unmounts (tab/agent closed).
    return () => {
      // Close waterfall: removeAgent started a "close:<id>" trace; this pane unmounting is the end
      // of the visible close cost. A no-op if the unmount wasn't a user close (e.g. project switch).
      perfEnd(`close:${agent.id}`, "unmounted");
      // Drop any still-open spawn trace so a pane closed mid-prepare can't leak its start entry.
      perfCancel(agent.id);
      // Increment the generation counter to invalidate any in-flight prepare() run. If
      // startOrchestrationBridge resolves AFTER this cleanup runs, the build branch's token
      // comparison (myRun !== prepareRunRef.current) will detect the staleness and stop the bridge.
      prepareRunRef.current++;
      stopHookWatch();
      // A build agent owns an orchestration bridge for its lifetime — stop it on close so its
      // socket + accept thread don't linger. Present THIS run's owner token so a fast close-reopen
      // can't tear down a newer run's bridge (). Purge this build agent's queued spawns
      // + in-flight reservations so a closed orchestrator's deferred requests don't linger and
      // over-count a later reincarnation's cap.
      if (agent.kind === "build") {
        purgeBuildAgent(agent.id);
        void stopOrchestrationBridge(agent.id, bridgeLaunchTokenRef.current).catch((e) =>
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

  // NOTE: exhaustion is no longer inferred from this pane's terminal output. See the comment in
  // Terminal.tsx's output handler and services/rateLimitWatch — a real limit is read from the
  // structured `error: "rate_limit"` record in the account's own transcripts, which is authoritative
  // and self-attributing, instead of guessed from text that any agent can print.

  // Publish this pane's PTY readiness so the concierge send path can tell "still coming up" (queue
  // the prompt) from "the process exited" (fail it truthfully) — see services/paneReadiness. A
  // GIVEN-UP pane (spawn error / Claude missing) publishes `failed` so a prompt sent AFTER the
  // pane settled there fails truthfully instead of re-queuing into a hold nobody will ever drain
  // (roborev 46924); a successful Retry re-enters the prepare flow and republishes. On unmount the
  // entry goes AND any prompt still held for this agent is dropped: the pane is gone for good, so
  // delivering it into a later reincarnation would be worse than losing it.
  useEffect(() => {
    if (phase === "error" || phase === "no-claude") setPaneFailed(agent.id);
    else setPaneReady(agent.id, ptyReady);
  }, [agent.id, ptyReady, phase]);
  useEffect(
    () => () => {
      unregisterPane(agent.id);
      unregisterPaneRestart(agent.id);
      unregisterPaneAccount(agent.id);
      // Report (not just drop) anything still held — the concierge promised the user a delivery
      // and must say what actually happened (roborev 46311).
      abandonPendingSends(agent.id);
    },
    [agent.id],
  );

  // Publish this pane's re-spawn lever so a global account switch can move this agent when it
  // reaches a safe boundary. The spawn path resumes the Claude session, so this continues the
  // conversation; accountSwitch owns choosing a moment where that costs nothing.
  //
  // This must RE-PREPARE, not just restart the terminal. `Terminal.restart()` only bumps its own
  // `attempt`, and its spawn effect re-reads the `args` PROP — which still holds the exec string
  // built during the last prepare(), with the OLD account's CLAUDE_CONFIG_DIR baked in. Only
  // prepare() re-reads the pin (chooseAccountForAgent → getPin), rebuilds the exec, and
  // re-publishes registerPaneAccount. Going through it is what makes a switch real; the terminal
  // then remounts via its account-derived key above.
  // `prepare` is re-created every render, so the registry gets a ref that always calls the latest.
  // Synced in an effect, never during render.
  const prepareRef = useRef(prepare);
  useEffect(() => {
    prepareRef.current = prepare;
  });
  useEffect(() => {
    registerPaneRestart(agent.id, () => void prepareRef.current());
    return () => unregisterPaneRestart(agent.id);
  }, [agent.id]);

  // A spawn that ERRORS or finds no Claude will never flip ptyReady, so a held prompt would dangle
  // with no outcome. Report it the moment the pane gives up (roborev 46311).
  //
  // `no-claude` IS a trigger, despite its Retry offering a way back: nothing ages a hold out on its
  // own (roborev 46897 — MAX_AGE_MS is only consulted inside flushPendingSends, which this pane
  // never reaches while it is stuck, so no `expired` is ever emitted). The choice is therefore
  // between telling the user now that the message didn't go, and going silent for the rest of the
  // session on a pane that may never unmount. Telling them wins: the concierge names the agent and
  // says to send it again once it's running, which is exactly what a successful Retry allows.
  useEffect(() => {
    if (phase === "error" || phase === "no-claude") abandonPendingSends(agent.id);
  }, [phase, agent.id]);

  // Flush any prompt the user sent while this agent's PTY was still coming up (services/
  // pendingSends): "create an agent, then tell it what to do" reaches the dispatch path before the
  // spawn finishes, and the composer used to queue-and-deliver exactly this way. Runs the moment
  // this pane reports ready — no-op when nothing is held for this agent.
  useEffect(() => {
    if (!ptyReady) return;
    void flushPendingSends(agent.id).catch((e) =>
      console.warn("flushPendingSends failed", e),
    );
  }, [ptyReady, agent.id]);

  // The visible, ready pane takes the caret: with no composer floating over it, the terminal IS
  // the input surface for anyone who does want to type directly. rAF lets the just-revealed
  // surface mount/show first.
  //
  // …but NEVER out from under a HALF-TYPED message. `ptyReady` flips asynchronously after spawn,
  // so a user composing in the concierge box while an agent finishes starting would otherwise have
  // the caret yanked mid-sentence — against the whole premise that the concierge is the one
  // compose surface. The guard is "unsent text in the focused field", not "any field focused", so
  // an empty concierge box (the steady state) still yields the caret to the terminal. Re-checked
  // inside the rAF, not just at effect time, because the frame lands later.
  useEffect(() => {
    if (!visible || !ptyReady) return;
    const raf = requestAnimationFrame(() => {
      if (isTypingInProgress()) return;
      termFocusRef.current?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, ptyReady]);

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

  // Switch waterfall end (perfTrace) — see settleSwitchTrace.
  useEffect(() => settleSwitchTrace(`switch:${agent.id}`, visible), [visible, agent.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        // Hide an inactive pane WITHOUT collapsing its box (no `display: none`) so its terminal
        // stays measured and never re-renders into a thin column on reveal. See paneVisibility.ts.
        ...paneVisibilityStyle(visible),
        flexDirection: "column",
        // THE SPEC'S `term` PLANE — the pane's whole surface, and the colour the selected agent
        // row is painted in so it reads as an opening into here.
        background: TERM_PLANE,
        // NO VERTICAL RULE ON THE BUILD SIDE, deliberately and permanently. The direction is
        // explicit that build and terminal are ONE thing inside a pair, and the selected row bleeds
        // 9px across that boundary. A border here — on either column — cancels the bleed and turns
        // an opening into a dock. See terminalChrome and the sidebar's own `borderRight: none`.
      }}
    >
      <PinnedPrompt
        prompt={agent.lastPrompt}
        // Dispatched/seed prompts only — picker answers live in the raw history (for naming's
        // promptCount) but are filtered out of every display surface. See composerPrompts.
        history={composerPrompts(agent.promptHistory ?? [])}
        // No "Send to Composer": there is no composer here any more. The concierge box is the one
        // place a prompt is written, so re-sending an old prompt happens there.
        // Jump the terminal back to where a prompt was sent. "missing" → the row reports it's
        // scrolled out of this session (marker trimmed or from a prior session).
        onJumpToPrompt={(id) => terminalApiRef.current?.scrollToPrompt(id) ?? "missing"}
      />

      {phase === "error" && (
        <Centered>
          <div style={{ color: C.sienna, marginBottom: 10 }}>Couldn't start this agent</div>
          {/* Read on the terminal plane, so it takes the terminal's secondary ink — `C.muted` is a
              PLANE ink for the shell's surfaces, not for this one. */}
          <div
            style={{
              color: termMuted(resolvedTheme),
              fontSize: TERM_TYPE.body,
              maxWidth: 480,
              marginBottom: 16,
            }}
          >
            {errorMsg}
          </div>
          <PrimaryButton onClick={() => void prepare()}>Try again</PrimaryButton>
        </Centered>
      )}
      {phase === "no-claude" && <Onboarding onRetry={() => void prepare()} />}
      {(phase === "preparing" || (phase === "ready" && spawn)) && (
        // Relative stage: the terminal fills it; the composer floats over the bottom as an
        // overlay (so dragging the composer never resizes/reflows the terminal beneath it). The
        // composer mounts during "preparing" too — as the SAME element across the preparing→ready
        // transition — so a draft typed while the agent's workspace spins up is preserved (the
        // element is never remounted) and an eager send is queued + auto-delivered when ready.
        <div ref={setTerminalStage} style={{ position: "relative", flex: 1, minHeight: 0 }}>
          {/* Drag-over affordance. Sits directly in this positioned box so it covers the terminal
              whatever `phase` is rendering — a file dropped while the workspace is still preparing
              is staged just the same, so refusing to say so would be the misleading half. */}
          {terminalDrop.dropActive && <TerminalDropOverlay agentName={agent.name} />}
          {phase === "ready" && spawn ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              padding: TERMINAL_STAGE_PADDING,
              boxSizing: "border-box",
            }}
          >
            <Terminal
              // Keyed on the account so a SWITCH actually takes effect. The account is baked into
              // `args` (buildClaudeExec writes `export CLAUDE_CONFIG_DIR=…` into the exec string),
              // but Terminal's spawn effect is keyed on [agentId, attempt] and does NOT watch
              // `args` — so rebuilding them alone would re-spawn onto the OLD config dir, and the
              // switch would silently do nothing while reporting success. Changing the key remounts
              // the terminal, which spawns fresh with the new dir; the spawn resumes the Claude
              // session, so the conversation is redrawn rather than lost.
              key={chosenAccount?.id ?? "default"}
              agentId={agent.id}
              projectId={project.id}
              projectRootPath={project.rootPath}
              command={spawn.command}
              args={spawn.args}
              cwd={spawn.cwd}
              resuming={spawn.resuming}
              calm={calm}
              // Selects Local vs Cloud transport. For a cloud agent, command/args/cwd above are
              // placeholders — CloudTransport ignores them and attaches to the server session.
              runtime={agent.runtime}
              active={visible}
              onStatus={(s) => routerRef.current!.fromScreen(s)}
              onReady={() => {
                perfEnd(agent.id, "pty ready"); // final milestone of the spawn waterfall
                setPtyReady(true);
              }}
              onExit={() => {
                // NOTE (Plan-1 limitation): this block fires only when the PTY process actually
                // exits — i.e. the user explicitly quits `claude` (e.g. /exit). Because
                // buildClaudeExec launches `claude` in its interactive REPL mode, an active worker
                // that finishes its task and writes result.json will remain alive in the REPL; it
                // does NOT exit. A PROGRAMMATIC KILL CAN STILL REACH HERE, and the comment that
                // used to sit here ("Terminal also removes its exit listener before killPty, so a
                // programmatic kill won't reach here either") was wrong twice over. The unlisten is
                // async and fire-and-forget, so the old effect's handler could still fire — that
                // part is now closed by Terminal's `disposed` guard (roborev 55107). But pty events
                // are addressed by AGENT ID, not by PTY instance, and the id is identical across
                // attempts: on "Start again" the NEW effect has already subscribed by the time the
                // old PTY's reader thread emits its exit, so the event lands on a handler that is
                // not disposed (roborev 55114). Closing THAT needs a spawn epoch echoed back from
                // Rust so the transport can drop events from a previous generation — not done here.
                // Until then, treat a call to this block as "an exit for this agent id arrived",
                // not as proof that THIS attempt's process exited. In practice it rarely fires for
                // interactive workers. Plan 2 reads result.json by polling
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
                        // No result.json here almost always means teardown, not a real failure:
                        // cancelling/deleting an agent removes its worktree and kills the PTY, and
                        // this exit listener can race in AFTER the worktree is gone, so the read
                        // returns null. read_worker_result can't tell "worktree deleted" from
                        // "result absent" — both are null — so this can't reliably flag a genuine
                        // stranded worker anyway (that's surfaced structurally by workerAttention's
                        // red overlay). Keep it at debug so a benign teardown doesn't bury real
                        // signal in the WARN stream.
                        console.debug(`[worker ${agent.id}] exited with no result.json`);
                        return;
                      }
                      const r = parseWorkerResult(raw);
                      console.info(`[worker ${agent.id}] ${r.status}: ${r.summary}`);
                    })
                    .catch((e) => console.error(`[worker ${agent.id}] bad result.json`, e));
                }
              }}
              // Meter free-trial prompts typed straight into the terminal. Terminal's onSubmitLine
              // fires once per non-empty submitted line (terminalSubmit.ts), so one prompt = one
              // decrement. Now UNCONDITIONAL: with the composer gone this is the only in-terminal
              // send path (the concierge dispatch meters its own — see conciergeDispatch).
              // recordTrialSend self-gates, no-opping for entitled users.
              onSubmitLine={() => {
                void recordTrialSend();
                // ROUTE 5 of engine/newAgentAttention.isBriefless, and the only DURABLE evidence a
                // hand-driven agent was ever briefed. interactionStore is in-memory, so on its own
                // it loses this on relaunch while the persisted `createdAt` gate survives — and a
                // wedged agent would then read calm gray "New — not briefed" forever. Write-once.
                useProjectStore.getState().noteTerminalBrief(project.id, agent.id);
              }}
              focusRef={termFocusRef}
              apiRef={terminalApiRef}
            />
          </div>
          ) : (
            <Centered>
              Starting your agent's safe workspace — go ahead and start typing or talking now, and
              I'll send it the moment it's ready.
            </Centered>
          )}
          {/* NO COMPOSER HERE (CM-U7, PRD §3: "No composer above it — the only compose box is the
              concierge"). The prompt side-effects it used to own — appendPrompt, the jump-to-prompt
              terminal marker, auto-rename and the trial debit — now run in
              services/conciergeDispatch when the concierge delivers a prompt to this agent. */}
          {/* The recommended-action pill for this agent renders here too, pinned bottom-right over
              the CLI's input line — but it is PORTALED in by the concierge rather than rendered by
              this pane (see Concierge/ConciergeSuggestions), because its delivery wiring is the
              concierge's. The stage node published above is the container it lands in. */}
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
          {/* Confirmation of what a drop pasted into this terminal, and that it has NOT been sent
              (see useTerminalDrop / TerminalDropPill). Portaled, anchored above this pane. */}
          {terminalDrop.dropped && (
            <TerminalDropPill
              count={terminalDrop.dropped.count}
              images={terminalDrop.dropped.images}
              delivered={terminalDrop.dropped.delivered}
              agentName={agent.name}
              anchorRef={terminalStageRef}
              onDismiss={terminalDrop.dismiss}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Skip a re-render when nothing THIS pane depends on changed. A projectStore write for a SIBLING
 *  agent (a status flip, an activity narration, a prompt append) mints a new `projects` array + a new
 *  project object (mapProject/mapAgent) and re-renders Workspace — which, unmemoized, re-rendered
 *  EVERY mounted pane (terminal + composer) on every such write. But mapAgent replaces only the
 *  touched agent's object, so this pane's own `agent` ref is preserved, and the only `project` fields
 *  this pane's render (and ThinkPanel) read are the four scalars below. So when `agent` and `visible`
 *  and those scalars are unchanged, the pane's output is identical and we can safely bail. `agent`
 *  referential equality already re-renders on this pane's own updates; `visible` re-renders on switch.
 *  Internal store subscriptions (composerMinimized, scrollIntent, AI gates) are unaffected — memo only
 *  gates PARENT-driven re-renders, not the component's own subscriptions. */
export function arePanePropsEqual(
  a: { project: Project; agent: AgentTab; visible: boolean; calm?: boolean },
  b: { project: Project; agent: AgentTab; visible: boolean; calm?: boolean },
): boolean {
  return (
    a.agent === b.agent &&
    a.visible === b.visible &&
    !!a.calm === !!b.calm &&
    a.project.id === b.project.id &&
    a.project.rootPath === b.project.rootPath &&
    a.project.name === b.project.name &&
    a.project.defaultBranch === b.project.defaultBranch
  );
}

/** The live pane. Memoized (see arePanePropsEqual) so N open panes don't all re-render on every
 *  sibling-agent store write — the main render-thrash source when many agents are open. */
export const AgentPane = memo(AgentPaneInner, arePanePropsEqual);

/**
 * Small pill in the pane's top-right showing the Claude account this agent runs under. Click to
 * open a dropdown of all accounts and pin a different one for this agent (takes effect next spawn).
 * The pinned/active account is marked. Styling mirrors the app's other dark popovers (TopBar menus).
 */
/* Exported for AgentPane.accountBadge.test.tsx — the selected row's ink pairing is a live
   consumer of the neutral ladder (see theme/colors) and needs a guard of its own; the rest of
   AgentPane cannot be rendered in a test without the Tauri runtime. */
export function AccountBadge({
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
  const resolvedTheme = useResolvedTheme();
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
          // THIS CHIP SITS ON THE TERMINAL PLANE, so its edge is the terminal's rule. It carried
          // `C.muted` — an INK used as a border, and one whose only contrast floors are measured as
          // text on the shell's planes. `termHairline` is the token with a guard on this surface.
          border: `1px solid ${TERM_HAIRLINE}`,
          borderRadius: TERM_RADIUS.modal,
          color: termInk(resolvedTheme),
          fontFamily: TERM_UI,
          fontSize: TERM_TYPE.small,
          padding: "3px 8px",
          cursor: "pointer",
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
        }}
      >
        <span
          style={{ width: 6, height: 6, borderRadius: TERM_RADIUS.sm, background: C.teal }}
        />
        <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {chosenReal}
        </span>
        <span style={{ color: termMuted(resolvedTheme) }}>▾</span>
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
              // The menu's outline is drawn against the terminal plane behind it, so it takes the
              // terminal's rule. `C.hairline` is floored on every plane EXCEPT this one
              // (theme/chromeContrast.test.ts skips the pair) — here it is an unguarded edge.
              border: `1px solid ${TERM_HAIRLINE}`,
              borderRadius: TERM_RADIUS.modal,
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
              // The 10px secondary lines (alias, "not signed in", "default") are `muted` on an
              // unselected row — a transparent row, so they are read on the menu's `deepForest`
              // plane, which is what `muted` is for. On the SELECTED row the backdrop is
              // `C.pillFill`, and `muted` cannot clear the ink floor on that or any other chrome
              // fill in either theme — no palette value fixes it, so the ink moves rather than the
              // token (see THE NEUTRAL LADDER in theme/colors). `cream` is the on-fill ink; these
              // lines stay secondary by size, which is the distinction the row already used.
              const secondaryInk = active ? C.cream : C.muted;
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
                    borderRadius: TERM_RADIUS.input,
                    cursor: "pointer",
                    fontFamily: TERM_UI,
                    fontSize: TERM_TYPE.small,
                    // `cream` / `muted` / `pillFill` INSIDE the menu are correct and stay: these
                    // rows are read on the menu's own plane, not on the terminal's, and their
                    // pairing is the measured one (see the note below + AgentPane.accountBadge.test).
                    color: C.cream,
                    // pillFill, not forest — see the same note in ModelPill: forest on a
                    // deepForest menu draws no selection under the near-black palette.
                    background: active ? C.pillFill : "transparent",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: TERM_RADIUS.sm,
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
                      <span style={{ display: "block", color: secondaryInk, fontSize: TERM_TYPE.micro, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {alias}
                      </span>
                    )}
                    {!identity?.email && (
                      <span style={{ display: "block", color: secondaryInk, fontSize: TERM_TYPE.micro }}>not signed in</span>
                    )}
                  </span>
                  {a.isDefault && <span style={{ color: secondaryInk, fontSize: TERM_TYPE.micro, flexShrink: 0 }}>default</span>}
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
  const resolvedTheme = useResolvedTheme();
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        // Empty/preparing states are read straight on the terminal plane — its own quiet ink.
        color: termMuted(resolvedTheme),
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
