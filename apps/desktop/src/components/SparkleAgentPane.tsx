import { useCallback, useEffect, useRef, useState } from "react";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import {
  createAgentWorktree,
  installWorktreeGuard,
  assertWorkspaceIntegrity,
  acquireWorktreeLease,
  releaseWorktreeLease,
} from "../services/worktree";
import { checkClaude, claudeHasSession } from "../preflight";
import { registerSparkleTranscript } from "../services/sparkleTranscript";
import { buildClaudeExec, buildControlMcpConfig } from "../services/claudeSpawn";
import { startControlBridge, controlMcpPaths } from "../services/orchestrationLaunch";
import { sparkleControlProtocol } from "../services/buildAgent";
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
import {
  notePaneRelaunch,
  setPaneFailed,
  setPaneReady,
  unregisterPane,
} from "../services/paneReadiness";
import { registerPaneRestart, unregisterPaneRestart } from "../services/paneControl";
import {
  abandonPendingSends,
  abandonScreenHeldSends,
  flushPendingSends,
} from "../services/conciergeDispatch";
import { SparkleConsentBanner } from "./SparkleConsentBanner";
import { Terminal } from "./Terminal";
import { Onboarding } from "./Onboarding";
import { TerminalDropOverlay } from "./TerminalDropOverlay";
import { TerminalDropPill } from "./TerminalDropPill";
import { useTerminalDrop } from "../hooks/useTerminalDrop";
import { SPARKLE_TERMINAL_DND_TARGET } from "../services/dndTargets";
import { paneVisibilityStyle } from "./paneVisibility";
import { isTypingInProgress } from "../engine/focusGuard";
import { markTerminalAutoFocus } from "../services/terminalFocusIntent";

type Phase = "preparing" | "ready" | "no-claude" | "error";

const SHELL = "/bin/zsh";

/** How often the mounted pane refreshes its worktree lease (bead sparkle-hc7hvm). Far below the
 *  Rust-side TTL (`WORKTREE_LEASE_TTL_DEFAULT_SECS = 600s` in worktree.rs) so a live holder is never
 *  misread as stale between beats, and far above a render, so it costs nothing. */
const WORKTREE_LEASE_HEARTBEAT_MS = 60_000;

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
 *
 * THIS PANE HAS NO COMPOSE SURFACE OF ITS OWN. THE TERMINAL IS THE INPUT SURFACE. Three founder
 * instructions, and reading any one of them alone gets this pane wrong:
 *
 *  - 2026-07-29: "the improved Sparkle agent has some old composer window functionality that should
 *    be stripped out so that it works like other build agents do" — the mic, the "I'm listening"
 *    placeholder, the screenshot button, attachments, the drop catch-all that swallowed terminal
 *    drops. Plus, on the same screenshots: "I don't want you to strip out the top functionality
 *    here… Just this bottom composer functionality" — the CONSENT ROW stays.
 *  - 2026-08-12: "There's a problem where the improved sparkle agent doesn't have a row to type
 *    into." Said while this agent sat BLOCKED ON HIM with no visible way to receive an answer. A
 *    `SparkleAgentInputRow` — a textarea and a Send button writing straight into this agent's PTY —
 *    was added at the bottom of this pane in response.
 *  - 2026-08-12, later the same day, on seeing it: *"You added a secondary composed window to
 *    improve sparkle I don't need that. You can take it out. I just didn't have the actual terminal
 *    last time, and now it's back. Just make sure that that doesn't go away."*
 *
 * THE THIRD MESSAGE IS THE ONE THAT EXPLAINS THE OTHER TWO. The missing "row to type into" was never
 * a request for a second compose box — it was the TERMINAL being absent. A terminal is a row you
 * type into, and once it came back the extra box was a duplicate of it. So the row is gone again,
 * and what replaced it is not another surface but a GUARD: `SparkleAgentPane.terminal.test.tsx`
 * fails if this pane stops rendering its `Terminal`. That guard is the founder's actual ask — *"just
 * make sure that that doesn't go away"* — and it is the durable half of this change, because the
 * defect that produced the whole detour was a missing terminal that nothing was watching.
 *
 * What did NOT come back with the input row, and is still absent, all deliberate:
 *  - No `composerOverlay` claim on the terminal. There is no box floating over it, so
 *    terminalSelectionReclaim has nothing to re-interpret (roborev 46485-M).
 *  - No `onRequestFocus` / `onUserRequestFocus`. The ⌘J chord is still swallowed here, and this pane
 *    still does not name itself the dictation surface — revealing it must not move the mic off the
 *    concierge box.
 *  - The terminal takes the caret on reveal (guarded by isTypingInProgress, so it never steals a
 *    half-typed message elsewhere).
 *  - Still no pinned prompt header. It used to echo the last composer send; with the concierge
 *    owning the send it degenerated into a static label, and the founder had that label removed
 *    outright (2026-07-30) rather than reworded. The consent row is the pane's top chrome.
 *  - The concierge path is UNTOUCHED — mounting the concierge to this row still works, and the
 *    readiness/paneControl publications below still back it. This is a second way in, not a
 *    replacement.
 */
export function SparkleAgentPane({ visible, agentId }: { visible: boolean; agentId: string }) {
  const [phase, setPhaseState] = useState<Phase>("preparing");
  // Synchronously-readable phase — see AgentPane for why the restart lever needs this rather than
  // the React state: `prepare()` swallows its own failures, so the phase is the only evidence.
  const phaseRef = useRef<Phase>("preparing");
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const [errorMsg, setErrorMsg] = useState("");
  const [spawn, setSpawn] = useState<SpawnCmd | null>(null);
  const [ptyReady, setPtyReady] = useState(false);
  // THE TERMINAL GAVE UP ON A LAUNCH THAT NEVER TOUCHED `phase` — its own spawn rejection.
  //
  // Same shape, same reason as AgentPane's `gaveUp`: `Terminal` catches a rejected spawn chain and
  // sets only its own overlay, so neither the readiness derive below nor the abandon effect fires and
  // this pane stays published as "starting" forever — every concierge send to it queued against a
  // launch that has already failed. Pane STATE rather than a direct `setPaneFailed` write, so the
  // registry value stays derivable (paneReadiness's contract), and cleared on ready so a successful
  // retry recovers even when `ptyReady` is already true and React bails out of the re-render.
  const [gaveUp, setGaveUp] = useState(false);
  // Why this machine can't open PRs, if it can't (null = it can, or we couldn't tell). Set during
  // prepare() so the pane says the same thing the agent was told — see submitBlockedReason.
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const setStatus = useRuntimeStore((s) => s.setStatus);
  const termFocusRef = useRef<(() => void) | null>(null);
  const terminalBoxRef = useRef<HTMLDivElement | null>(null);
  // The clone root this pane holds the WORKTREE LEASE against, captured once the repo is located in
  // prepare(). While a lease is held the hourly headless improvement pass refuses to reset this
  // shared worktree's branch out from under the live session (bead sparkle-hc7hvm). Null until
  // prepare() resolves the repo path; the heartbeat below is a no-op until then.
  const leaseRootRef = useRef<string | null>(null);
  // A file dropped ON THIS TERMINAL pastes its (shell-quoted) path at the CLI's input line, exactly
  // like a build agent's terminal — a drop lands where it was dropped. Before this, the pane
  // composer's catch-all listener took the whole pane, so a terminal drop was loaded as an
  // attachment — and the loader refuses paths outside $HOME/$TMPDIR/Volumes or under a
  // dot-directory, which is how a dropped .txt could disappear with only a log line. See
  // hooks/useTerminalDrop.
  //
  // That composer is now GONE (see the pane doc comment), so the terminal is the pane's ONLY drop
  // surface — there is no longer a sibling compose box to split drops with. The claim on the
  // terminal box stays explicit anyway: it is what scopes the drag-over scrim to the terminal and
  // anchors the "pasted, not sent" pill, both of which outlived the composer.
  // terminal-focus: user-driven — NOT marked as an app-placed caret, matching `AgentPane`'s identical
  // drop path. Dropping a file onto a terminal is as much an act of aim as clicking into it, so the
  // caret arriving here is the user's intent; marking it would tell the Escape ladder the app parked
  // them, and one Escape would drop the cable out from under someone who just aimed at this agent.
  // `terminalAutoFocusSites.test.ts` is what required this line to exist — it caught this site the
  // moment the pane grew it, which is exactly what it was written for.
  const focusTerminalForDrop = useCallback(() => termFocusRef.current?.(), []);
  const terminalDrop = useTerminalDrop(
    visible,
    agentId,
    focusTerminalForDrop,
    SPARKLE_TERMINAL_DND_TARGET,
  );

  const prepare = async () => {
    // Always a local claude agent, so every prepare genuinely replaces the PTY. Announced
    // synchronously, before any await, so a waiter can tell the restart began — see
    // paneReadiness.notePaneRelaunch.
    notePaneRelaunch(agentId);
    setPhase("preparing");
    setGaveUp(false);
    setErrorMsg("");
    setPtyReady(false);
    try {
      // If an hourly headless pass is mid-flight (improvementPass.ts), kill it first: two
      // `claude` processes must never share this worktree. Nothing is lost — the interactive
      // session below resumes the worktree's most recent conversation, including the pass's.
      await cancelImprovementPass().catch(() => {});
      // App-owned workspace: clone the OSS repo (once) + locate the log dir. Never the user's project.
      const ws = await ensureSparkleRepo();
      // CLAIM THE WORKTREE (bead sparkle-hc7hvm). This pane and the hourly headless pass share the
      // `__sparkle_self__` checkout; the pass parks it with `checkout -B`, which would switch HEAD
      // out from under this live session. Take the lease NOW — before the worktree is even cut — and
      // heartbeat it from the effect below, so the park declines `in-use` for as long as this pane is
      // alive. Best-effort: a failed claim costs the backstop, not the session.
      leaseRootRef.current = ws.repoPath;
      void acquireWorktreeLease(ws.repoPath, SPARKLE_PROJECT_ID, agentId).catch((e) =>
        console.warn("worktree lease claim failed (park's own valves still protect):", e),
      );
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
      // Register this worktree so the concierge can READ this agent once the pane is unmounted
      // (tier (d) — see services/sparkleTranscript). The worktree, not a file: which session is live
      // changes over this agent's life, so tier (d) resolves that at read time.
      registerSparkleTranscript(agentId, wt.path);
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

      // THE sparkle-control MCP — this agent's ONLY route to the rest of the app (bead
      // sparkle-hdlhox). Without it Improve Sparkle has no `get_state({scope:"fleet"})` to read the
      // app-global address book and no `send_peer_message` to reach the concierge at
      // `sparkle:concierge`, so the cross-agent channel that already exists on main (bead
      // sparkle-179b2s) is invisible to the one agent whose whole job is noticing systemic problems.
      // It reported itself blind on that basis, having reached for the HARNESS's ListAgents — a
      // different namespace that can never contain the concierge.
      //
      // Built exactly like AgentPane's generic branch, deliberately: one pattern, not two.
      let control: { paths: { nodePath: string; serverPath: string }; socketPath: string; token: string } | null =
        null;
      try {
        const [bridge, paths] = await Promise.all([startControlBridge(), controlMcpPaths()]);
        control = { paths, socketPath: bridge.socketPath, token: bridge.token };
      } catch (e) {
        // DEGRADE, NEVER FAIL. A bridge that will not start costs this agent its cross-agent tools
        // and nothing else — the pane still spawns with its persona, log dir and mission prompt.
        // That is the brief's hard constraint: the channel must degrade safely when the other side
        // is absent, and the absent side here is the app's own bridge.
        console.warn("[control] sparkle-control MCP unavailable for Improve Sparkle; spawning without it", e);
      }
      const controlMcpConfig = control
        ? buildControlMcpConfig({
            nodePath: control.paths.nodePath,
            serverPath: control.paths.serverPath,
            socketPath: control.socketPath,
            token: control.token,
            agentId,
          })
        : undefined;
      // Named rather than inlined into the ternary below so the gate is ONE testable predicate:
      // the flag and the prose that advertises it are driven by the same value, and a mutation to
      // this line flips both together the way a real regression would.
      const controlUp = controlMcpConfig !== undefined;
      const persona = sparklePersona(
        ws.logDir,
        wt.path,
        consent,
        submit?.verdict ?? "unknown",
        // The pane IS the user sitting in the chat, so an auth failure is theirs to clear.
        { attended: true },
      );
      setSpawn({
        command: SHELL,
        args: [
          "-l",
          "-c",
          buildClaudeExec(claude.path, resume, {
            // The control-protocol prose rides ONLY when the server actually loaded. Advertising
            // tools that are not there just yields confusing "tool not found" attempts — the same
            // reason AgentPane gates it on the identical value.
            appendSystemPrompt: controlUp ? `${persona}\n\n${sparkleControlProtocol()}` : persona,
            // No `strictMcpConfig`: the user's own global MCP servers must still load alongside
            // ours, matching AgentPane's generic branch.
            mcpConfig: controlMcpConfig,
            // Ownership proof for the Stop hook's inbox drain (bead sparkle-ei7keg): the same
            // window id the hook-events log and the inbox would be keyed by.
            //
            // INERT TODAY, DELIBERATELY. This pane never calls `installAgentHooks`, so no Stop hook
            // is registered in its worktree and nothing reads this yet. It is set anyway because
            // the alternative is a silent hole the day hooks ARE installed here: the drain fails
            // CLOSED, so a missing export presents as "the Improve-Sparkle agent stopped receiving
            // messages" with nothing in the diff that installed hooks to explain it.
            inboxAgentId: agentId,
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

  // ── JOINING THE REGISTRIES THE CONCIERGE SEND PATH DEPENDS ON ───────────────────────────────
  //
  // This pane never registered with paneReadiness/paneControl, and that was HARMLESS ONLY WHILE IT
  // OWNED A COMPOSER: the composer's `preparing={!ptyReady}` was this pane's private queue, holding
  // an eager send and flushing it on the preparing→ready transition, and its `onRestartAgent` was
  // this pane's private dead-PTY heal. Both are gone, and the concierge is now the only way in — so
  // without these effects `paneState(agentId)` stays `"unmounted"` forever, `wasStarting` in
  // conciergeDispatch is always false, and a prompt sent while this pane is still coming up
  // (worktree creation → repo prepare → Claude preflight, all slow) HARD-FAILS as `pty-gone` and is
  // discarded rather than held. Removing the composer without this would have relocated the very
  // bug the composer's queue existed to prevent (roborev 55564).
  //
  // Same three publications AgentPane makes, for the same reasons:
  //  • readiness, so "still coming up" (queue) is distinguishable from "the process exited" (fail
  //    truthfully). A GIVEN-UP pane publishes `failed`, so a prompt sent after it settles there
  //    fails instead of re-queuing into a hold nobody will drain; a successful Retry republishes.
  //  • the respawn lever, WHICH IS ALSO WHAT MAKES THE CONCIERGE'S OWN REMEDY COPY TRUE. On a dead
  //    PTY it says "Start it again and I'll pass it along" — an instruction the user could not
  //    follow here once the composer's restart went, because `restartPane` had nothing registered.
  //  • on unmount: drop the entries and REPORT anything still held, rather than silently losing a
  //    delivery the concierge already promised.
  useEffect(() => {
    if (gaveUp || phase === "error" || phase === "no-claude") setPaneFailed(agentId);
    else setPaneReady(agentId, ptyReady);
  }, [agentId, ptyReady, phase, gaveUp]);
  // `prepare` is re-created every render, so the registry gets a ref that always calls the latest.
  // A full RE-PREPARE, not `Terminal.restart()`: the exec string in `args` was built by the last
  // prepare (consent mode, --add-dir, resume-vs-fresh all baked in), so only going through prepare
  // rebuilds it. Synced in an effect, never during render.
  const prepareRef = useRef(prepare);
  useEffect(() => {
    prepareRef.current = prepare;
  });
  useEffect(() => {
    registerPaneRestart(agentId, async () => {
      await prepareRef.current();
      return phaseRef.current;
    });
    return () => unregisterPaneRestart(agentId);
  }, [agentId]);
  useEffect(
    () => () => {
      unregisterPane(agentId);
      abandonPendingSends(agentId);
      abandonScreenHeldSends(agentId);
    },
    [agentId],
  );
  // WORKTREE LEASE HEARTBEAT (bead sparkle-hc7hvm). While this pane is mounted, keep refreshing the
  // lease so the hourly headless pass reads it as fresh and refuses to reset this shared worktree's
  // branch. Interval is far below the Rust-side TTL (WORKTREE_LEASE_TTL_DEFAULT_SECS = 600s) so a
  // live holder is never misread as stale; on unmount, RELEASE it so the pass may run again at once
  // rather than waiting out the TTL. prepare() takes the first lease before this runs; this only
  // refreshes and tears down. Best-effort throughout — the park's own valves stand underneath it.
  useEffect(() => {
    const beat = () => {
      const root = leaseRootRef.current;
      if (root)
        void acquireWorktreeLease(root, SPARKLE_PROJECT_ID, agentId).catch((e) =>
          console.warn("worktree lease heartbeat failed:", e),
        );
    };
    const id = setInterval(beat, WORKTREE_LEASE_HEARTBEAT_MS);
    return () => {
      clearInterval(id);
      const root = leaseRootRef.current;
      if (root)
        void releaseWorktreeLease(root, SPARKLE_PROJECT_ID, agentId).catch((e) =>
          console.warn("worktree lease release failed (TTL will reclaim it):", e),
        );
    };
  }, [agentId]);
  // Flush anything held while this pane's PTY was coming up. No-op when nothing is held.
  useEffect(() => {
    if (!ptyReady) return;
    void flushPendingSends(agentId).catch((e) => console.warn("flushPendingSends failed", e));
  }, [ptyReady, agentId]);
  // A spawn that ERRORS or finds no Claude never flips ptyReady, so a held prompt would dangle with
  // no outcome. Report it the moment the pane gives up (roborev 46311) — the pane may never unmount.
  useEffect(() => {
    if (gaveUp || phase === "error" || phase === "no-claude") {
      abandonPendingSends(agentId);
      abandonScreenHeldSends(agentId);
    }
  }, [phase, agentId, gaveUp]);

  // The visible, ready pane takes the caret: with no composer over it, the terminal IS this pane's
  // input surface for anyone who wants to type directly. Verbatim the rule AgentPane follows, and
  // it REPLACES the old composerMinimized dance (minimized → terminal, restored → composer), which
  // described a box that no longer exists.
  //
  // …but NEVER out from under a HALF-TYPED message. `ptyReady` flips asynchronously after spawn, so
  // a user composing in the concierge box while this agent finishes starting would otherwise have
  // the caret yanked mid-sentence — against the premise that the concierge is the one compose
  // surface. Re-checked inside the rAF, not just at effect time, because the frame lands later.
  useEffect(() => {
    if (!visible || !ptyReady) return;
    const raf = requestAnimationFrame(() => {
      if (isTypingInProgress()) return;
      // THE APP MOVING THE CARET, NOT THE USER — the second such site, and it was missed the first
      // time this was wired (roborev 55722). Unmarked, this pane recorded a parked caret as
      // deliberate, so its Escape ladder was the inverse of a builder pane's: the first press did not
      // release the cable. See `services/terminalFocusIntent`; `AgentPane` marks the equivalent
      // effect, and `terminalAutoFocusSites.test.ts` requires every such site to declare itself.
      markTerminalAutoFocus();
      termFocusRef.current?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, ptyReady]);

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
      {/* NO PINNED HEADER ON THIS PANE. Founder, 2026-07-30: the static "Sparkle Improvement Agent
          — making Sparkle better from your usage" label is gone, not reworded. The element is
          deleted rather than passed an empty prompt because PinnedPrompt renders nothing at all for
          an empty prompt (see PinnedPrompt.tsx's "no placeholder" contract), so keeping it would be
          dead markup. It also carried its own padding + bottom hairline rather than spacing a
          sibling, so the consent row below simply becomes this pane's top chrome — no gap to close.
          SparkleAgentPane.noComposer.test.tsx pins the absence. */}
      {/* THE CONSENT ROW STAYS. Founder, 2026-07-29, on the screenshot: "I don't want you to strip
          out the top functionality here." It is how the user answers "Can we use your logs & crash
          reports to automatically improve Sparkle?", it gates what leaves the machine (see the Rust
          upload gate), and it has nothing to do with composing a message. */}
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
        <>
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          {/* The terminal's own drop region (useTerminalDrop above). Tauri's drag events are
              window-global and carry no target element, so the hit test needs a marked box.

              THIS BOX SPANS THE WHOLE PANE, and with the pane composer gone it is the pane's ONLY
              drop surface — there is no second surface to divide the pane with, so nothing here
              depends on paint order any more. It used to: the box was deliberately z-ordered just
              BELOW `COMPOSER_Z` so a drop on the compose box overlaying this strip resolved to the
              composer rather than pasting a path into the PTY (roborev 55575). That composer was
              stripped when Improve Sparkle moved to the mounted concierge, and this pane was its
              last render site, so the ordering it was ranked against no longer exists.

              THE EXPLICIT z-index STAYS, for the other half of what it always bought: it makes this
              box a STACKING CONTEXT, which is what traps the `inset: 0` drag-over scrim inside the
              terminal region instead of letting it paint across the consent banner above it (the
              pinned prompt that used to sit above that banner is gone too — see the pane doc). The value only has to be a real number for that; it is no longer derived from
              anything. `SparkleAgentPane.drop.test.tsx` asserts the containment, not the number. */}
          <div
            ref={terminalBoxRef}
            data-dnd-target={SPARKLE_TERMINAL_DND_TARGET}
            style={{ position: "absolute", inset: 0, padding: 6, zIndex: 1 }}
          >
            {terminalDrop.dropActive && <TerminalDropOverlay agentName="Sparkle" />}
            <Terminal
              agentId={agentId}
              projectId={SPARKLE_PROJECT_ID}
              projectRootPath={spawn.projectRootPath}
              command={spawn.command}
              args={spawn.args}
              cwd={spawn.cwd}
              resuming={spawn.resuming}
              active={visible}
              // NO `composerOverlay`. That prop exists to reclaim a plain drag over a
              // mouse-tracking TUI as a text selection *while a composer is open over the terminal*
              // (roborev 46485-M, terminalSelectionReclaim). This pane was its last consumer; with
              // the composer gone the terminal owns the whole stage and its own mouse mode again,
              // which is how AgentPane has always mounted it.
              onStatus={(s) => setStatus(agentId, s)}
              onReady={() => {
                // Clear the gave-up latch here, not only in `prepare()`: Terminal's own "Start again"
                // is an internal attempt bump that never re-enters `prepare()`, so a prepare-only
                // clear would leave this pane published `failed` through a successful retry.
                setGaveUp(false);
                setPtyReady(true);
              }}
              // Terminal owns the spawn rejection and it never reaches `phase`; without this the pane
              // stays "starting" forever and concierge sends queue against a dead launch.
              onSpawnFailed={() => setGaveUp(true)}
              // NO `onRequestFocus` / `onUserRequestFocus` either: both handed the caret to the
              // composer, and the ⌘J one additionally named THIS pane as the dictation surface.
              // With nothing to focus, the chord is swallowed (Terminal returns false either way)
              // and revealing this pane can no longer take the mic off the concierge box.
              focusRef={termFocusRef}
            />
          </div>
          {/* What a drop pasted into this terminal — and that it has NOT been sent. Same pill the
              build-agent panes use (see useTerminalDrop / TerminalDropPill). This OUTLIVES the
              stripped composer: the pill reports on the terminal paste, not on a compose surface. */}
          {terminalDrop.dropped && (
            <TerminalDropPill
              count={terminalDrop.dropped.count}
              images={terminalDrop.dropped.images}
              delivered={terminalDrop.dropped.delivered}
              agentName="Sparkle"
              anchorRef={terminalBoxRef}
              onDismiss={terminalDrop.dismiss}
            />
          )}
        </div>
        {/* NO SECOND COMPOSE SURFACE. The input row that stood here for a few hours on 2026-08-12
            is gone — see the pane doc above for the founder's own reason. The TERMINAL is this
            pane's input surface, and `SparkleAgentPane.terminal.test.tsx` is the guard that it
            stays rendered. */}
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
