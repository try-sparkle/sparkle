// Launch wiring for the autonomous Build agent (Plan 2c). Starts the per-build-agent orchestration
// bridge, resolves the node + bundled-server paths, and assembles the `claude` PTY spawn so the
// build agent comes up with the sparkle-orchestrator MCP server attached (spawn_worker /
// list_workers / wait_for_workers / spin_down_worker) and the orchestrator persona. The bridge
// MUST be started before the PTY spawns (claude's MCP child connects to the socket at startup) and
// stopped when the build agent closes.
import { invoke } from "@tauri-apps/api/core";
import { buildClaudeExec, buildOrchestratorMcpConfig, SHELL } from "./claudeSpawn";

export interface BridgeInfo {
  socketPath: string;
  token: string;
}

export interface McpPaths {
  nodePath: string;
  serverPath: string;
}

/** Start (idempotently) the orchestration bridge for this build agent; returns its socket + token.
 *  `launchToken` is a per-prepare()-run nonce that stamps this launch as the bridge's owner: a
 *  re-prepare transfers ownership to the newest launch, and stopOrchestrationBridge only tears the
 *  bridge down when it presents the current owner's token — so a stale run's cleanup (a sub-second
 *  close-reopen, or a superseded prepare()) can't destroy a newer run's live bridge (). */
export function startOrchestrationBridge(
  projectId: string,
  buildAgentId: string,
  launchToken: string,
): Promise<BridgeInfo> {
  return invoke<BridgeInfo>("start_orchestration_bridge", { projectId, buildAgentId, launchToken });
}

/** Stop the orchestration bridge for this build agent (on close). Only tears down when `launchToken`
 *  matches the bridge's current owner — a stale run presenting an old token is a no-op (). */
export function stopOrchestrationBridge(buildAgentId: string, launchToken: string): Promise<void> {
  return invoke<void>("stop_orchestration_bridge", { buildAgentId, launchToken });
}

/** Resolve the node binary + the bundled orchestrator server.js absolute paths. */
export function orchestratorMcpPaths(): Promise<McpPaths> {
  return invoke<McpPaths>("orchestrator_mcp_paths");
}

/** Pure assembler: given a started bridge + resolved paths, produce the build agent's PTY spawn.
 *  No initialPrompt — the user drives the build agent from the composer. */
export function assembleBuildSpawn(opts: {
  claudePath: string;
  resume: boolean;
  cwd: string;
  persona: string;
  bridge: BridgeInfo;
  paths: McpPaths;
  /** Chosen account's CLAUDE_CONFIG_DIR (multi Claude Max support). Threaded into the inner
   *  buildClaudeExec so build/orchestrator agents honor the selected account too. Undefined →
   *  default behavior (no per-spawn config dir). */
  configDir?: string;
  /** Newest Claude session id for this worktree. With `resume` true, spawns `--resume <id>` so the
   *  prior conversation is redrawn on reopen (bead sparkle-wwg7); undefined → `--continue`. */
  resumeSessionId?: string;
  /** This build agent's chosen Claude model (services/models.ts id). Undefined/"default" →
   *  no --model flag (inherit the user's Claude Code default). */
  model?: string;
}): { command: string; args: string[]; cwd: string } {
  const mcpConfig = buildOrchestratorMcpConfig({
    nodePath: opts.paths.nodePath,
    serverPath: opts.paths.serverPath,
    socketPath: opts.bridge.socketPath,
    token: opts.bridge.token,
  });
  const exec = buildClaudeExec(opts.claudePath, opts.resume, {
    mcpConfig,
    strictMcpConfig: true,
    appendSystemPrompt: opts.persona,
    configDir: opts.configDir,
    resumeSessionId: opts.resumeSessionId,
    model: opts.model,
  });
  return { command: SHELL, args: ["-l", "-c", exec], cwd: opts.cwd };
}
