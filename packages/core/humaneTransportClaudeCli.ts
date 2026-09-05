/**
 * humaneTransportClaudeCli — a `JudgeTransport` backed by the `claude` CLI in headless mode.
 *
 * WHY THE CLI AND NOT THE HTTP API (bead `sparkle-plmpnm`). The founder's constraint is a spend
 * rule, not a technical preference: *"I don't want to be doing anything that's outside of my
 * Claude Max subscription."* An `ANTHROPIC_API_KEY` is metered spend and is refused for these
 * lanes. Headless `claude -p` bills a SUBSCRIPTION — either the machine's own login, a rotation
 * account selected at call time, or a long-lived `claude setup-token` OAuth token. So the CLI is
 * not a workaround for the API; it is the only transport that satisfies the rule.
 *
 * PRIOR ART, DELIBERATELY COPIED: `apps/web/src/lib/llm-curator.ts` already drives headless
 * `claude` for the changelog curator, locally on a subscription and in CI on
 * `CLAUDE_CODE_OAUTH_TOKEN`. Its hard-won details are reproduced here rather than imported,
 * because `packages/core` must not depend on `apps/web`. Each one is commented with what it costs
 * to get wrong; `humaneTransport.test.ts` pins the flag set and the env allowlist so a
 * future edit cannot quietly drop one.
 */
import { spawn } from 'node:child_process';
import { answered, describeThrown, redactSecrets } from './humaneTransport.ts';
import type { JudgeReply, JudgeTransport, CredentialSource, JudgeUsage } from './humaneTransport.ts';

/**
 * THE FLAGS THIS TRANSPORT IS ALLOWED TO SEND, and why the list is closed.
 *
 * The CLI rejects an unknown option by exiting 1 with `unknown option '--x'`, which reaches the
 * gate as "the judge did not answer" on EVERY turn — the same shape as a dead credential, and
 * indistinguishable from one in a CI log. That is not hypothetical: `--max-output-tokens` (a real
 * Messages-API parameter, and NOT a CLI flag) was written here from the HTTP lane it replaced, and
 * it failed all six judge calls of the first real fleet run.
 *
 * Every entry below is a flag `apps/web/src/lib/llm-curator.ts` already sends in production
 * against the pinned CLI version, so this list is evidence rather than belief.
 */
export const ALLOWED_CLI_FLAGS: readonly string[] = [
  '-p',
  '--model',
  '--output-format',
  '--safe-mode',
  '--setting-sources',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--mcp-config',
  '--strict-mcp-config',
  '--tools',
];

/** A judge call that has not answered in this long is not going to. Bounds the whole lane. */
export const DEFAULT_CALL_TIMEOUT_MS = 180_000;

/**
 * THE HEADLESS INVOCATION, and every flag is load-bearing.
 *
 * `--setting-sources ''` is the one that surprises people: headless Claude Code still loads
 * user-level `~/.claude/CLAUDE.md`, settings, hooks and plugins regardless of cwd. On this machine
 * that injects agent instructions and backlog prose into a prompt that is supposed to be a frozen
 * rubric — measured by the curator at 1,942 -> 159 input tokens per call once these are set. For a
 * SCORER that is worse than wasteful: it makes the judged prompt depend on whose machine ran it,
 * so two runs of the same rubric are not the same experiment.
 *
 * `--tools ''` is variadic, so it MUST go last or it swallows whatever follows as a tool name.
 *
 * `--bare` would also strip the settings, and is WRONG here: it forces ANTHROPIC_API_KEY-only
 * auth, which is exactly the metered path the founder refused.
 */
export function buildJudgeArgs(model: string): string[] {
  return [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--safe-mode',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--strict-mcp-config',
    '--tools',
    '',
  ];
}

/**
 * The list above, enforced at RUNTIME rather than only in a test.
 *
 * An unknown option exits 1 on every call and reaches the gate as "the judge did not answer" on
 * every turn — indistinguishable from a dead credential in a CI log, which is exactly how
 * `--max-output-tokens` (a Messages-API parameter, and not a CLI flag) failed all six judge calls
 * of the first real fleet run. A test catches that only where the test runs; this makes shipping
 * one impossible, and it names the offending flag instead of burning a round trip to discover it.
 */
export function assertKnownFlags(args: readonly string[]): void {
  for (const a of args) {
    if (a.startsWith('-') && a !== '-' && !ALLOWED_CLI_FLAGS.includes(a)) {
      throw new Error(
        `${a} is not a flag the pinned Claude CLI is known to accept. An unknown option fails ` +
          `every judge call and reads as a dead credential. Add it to ALLOWED_CLI_FLAGS only ` +
          `once the pinned version is confirmed to accept it.`,
      );
    }
  }
}

/**
 * An ALLOWLIST, never a denylist. The parent environment in CI holds production database URLs and
 * every other secret exported into that step, and a judge subprocess has no business seeing any of
 * them. A denylist also cannot anticipate a newly-invented key variable.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  // Subscription auth: a CI token, and a non-default config location (how the fleet selects).
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/**
 * Redundant by construction — none of these is on the allowlist — and kept as a TRIPWIRE. If
 * someone widens the allowlist later, these must still never reach the child, or Claude Code
 * silently bills a metered API key instead of the subscription and the founder's spend rule is
 * broken by a change that looked unrelated.
 */
export const API_KEY_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_API',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
];

export function judgeChildEnv(
  env: Record<string, string | undefined>,
  configDir?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  for (const k of API_KEY_VARS) delete out[k];
  // The fleet's selection wins over anything inherited. An empty string is the machine-default
  // sentinel and must UNSET the variable rather than set it empty — an empty CLAUDE_CONFIG_DIR
  // is not "use the default", it is a path that does not exist.
  if (configDir !== undefined) {
    if (configDir === '') delete out.CLAUDE_CONFIG_DIR;
    else out.CLAUDE_CONFIG_DIR = configDir;
  }

  // A CHOSEN ACCOUNT AND AN OVERRIDE TOKEN ARE MUTUALLY EXCLUSIVE — and getting this wrong makes
  // the entire fleet feature silently inert.
  //
  // Claude Code PREFERS `CLAUDE_CODE_OAUTH_TOKEN` over the OAuth session stored in
  // `CLAUDE_CONFIG_DIR`. So passing both means the fleet picks an account, exports its config dir,
  // and every judge call bills the ONE hand-set token anyway: rotation does nothing, a dead token
  // fails all judges even though a live account was selected, and the verdict is still stamped
  // `lane: fleet`. That is the exact false-provenance defect this module exists to remove, and the
  // machine where it bites is the one that has BOTH — the founder's Mac.
  //
  // `scripts/claude-fleet.sh` scrubs the competing credential vars before its own `exec` for this
  // same reason; this is that precaution, carried over.
  if (configDir !== undefined && configDir !== '') delete out.CLAUDE_CODE_OAUTH_TOKEN;
  return out;
}

/**
 * `claude -p --output-format json` prints ONE JSON envelope. Scan from the END so a stray warning
 * line ahead of it cannot break parsing.
 */
export function parseJudgeEnvelope(stdout: string): JudgeReply {
  const trimmed = stdout.trim();
  if (trimmed === '') return { error: 'the judge CLI produced no output at all' };
  const starts: number[] = [];
  for (let i = 0; i < trimmed.length; i++) if (trimmed[i] === '{') starts.push(i);
  for (let i = starts.length - 1; i >= 0; i--) {
    let env: Record<string, unknown>;
    try {
      env = JSON.parse(trimmed.slice(starts[i] as number)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (env.is_error === true) {
      const msg = typeof env.result === 'string' && env.result ? env.result : 'the judge CLI reported an error';
      // The CLI's own error text may echo part of the offending request — redact at the producer
      // so no sink of this `error` can publish a live credential. See `redactSecrets`.
      return { error: redactSecrets(msg) };
    }
    const result = env.result;
    if (typeof result !== 'string' || result.trim() === '') {
      return { error: 'the judge CLI returned an envelope with no result text' };
    }
    return { text: result, usage: readUsage(env.usage) };
  }
  // Not JSON at all. Quote what it DID say — that sentence is usually the whole diagnosis
  // ("Not logged in", "Credit balance too low"), and throwing it away is bead `sparkle-g6cc8q`.
  // Redact first: this quotes up to 400 chars of ARBITRARY CLI stdout, the widest secret-leak
  // surface in this file, and its `error` is not guaranteed to reach a redacting publisher.
  return { error: `the judge CLI did not return JSON — ${redactSecrets(oneLine(trimmed, 400))}` };
}

function readUsage(raw: unknown): JudgeUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const inputTokens = typeof u.input_tokens === 'number' ? u.input_tokens : undefined;
  const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Injectable so the suite can drive the real code path without a real CLI. */
export interface RunCli {
  (args: string[], env: Record<string, string>, prompt: string, timeoutMs: number): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    spawnError?: string;
  }>;
}

/**
 * The DEFAULT runner — the line that is covered by nothing if every test injects its own.
 * Exported so the suite can assert on it directly (bead `sparkle-lgbwf`: a defaulted seam every
 * test injects means deleting the real implementation leaves the suite green).
 */
export function makeRunCli(binary: string): RunCli {
  return (args, env, prompt, timeoutMs) =>
    new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ code: null, stdout: '', stderr: '', spawnError: e instanceof Error ? e.message : String(e) });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (r: { code: number | null; stdout: string; stderr: string; spawnError?: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ code: null, stdout, stderr, spawnError: `the judge did not answer within ${timeoutMs}ms` });
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', (e) => finish({ code: null, stdout, stderr, spawnError: e.message }));
      child.on('close', (code) => finish({ code, stdout, stderr }));
      // The prompt goes on STDIN, never argv: a rubric prompt is far past any platform's argument
      // length limit, and a truncated prompt would score a DIFFERENT question without saying so.
      child.stdin?.on('error', () => {
        /* the child may exit before we finish writing; `close` carries the real verdict */
      });
      child.stdin?.end(prompt);
    });
}

export interface ClaudeCliTransportOptions {
  readonly source: CredentialSource;
  readonly describe: string;
  /** `undefined` leaves the inherited value alone; `''` means the machine-default login. */
  readonly configDir?: string;
  readonly binary?: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly runCli?: RunCli;
}

export function claudeCliTransport(opts: ClaudeCliTransportOptions): JudgeTransport {
  const binary = opts.binary ?? 'claude';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const runCli = opts.runCli ?? makeRunCli(binary);
  const env = judgeChildEnv(opts.env ?? process.env, opts.configDir);
  return {
    source: opts.source,
    describe: opts.describe,
    async ask(prompt, model) {
      // A transport MUST NOT throw — the failure contract lives in the return type.
      try {
        const cliArgs = buildJudgeArgs(model);
        assertKnownFlags(cliArgs);
        const r = await runCli(cliArgs, env, prompt, timeoutMs);
        if (r.spawnError !== undefined) return { error: r.spawnError };
        if (r.code !== 0) {
          // ── THE REASON IS IN THE ENVELOPE, PAST THE 400-CHAR CUT ──────────────────────────
          //
          // `claude -p --output-format json` does not only print its envelope on a CLEAN run: it
          // prints one and EXITS NON-ZERO when the call fails, with `result` — the single
          // human-readable sentence — placed AFTER the long `usage`/`cache_creation` block. So
          // quoting a 400-char prefix of stdout publishes the token counters and truncates the
          // diagnosis. Measured on the HumaneBench gate (run 33821995583): all three judges
          // failed, stderr was EMPTY, and every one reported the same unreadable prefix —
          //
          //   the judge CLI exited 1 — {"is_error":true,...,"cache_creation":{"ephemeral_1h_...
          //
          // — across three pull requests, with nothing anywhere saying WHY. `parseJudgeEnvelope`
          // already extracts `result` and redacts it; it was simply unreachable from here,
          // because this branch returns before it is ever called.
          //
          // ORDER MATTERS AND IS DELIBERATE. stderr wins when it has anything to say: a CLI that
          // dies before it can print an envelope explains itself there, and that is the older,
          // covered path. Only an EMPTY stderr falls through to the envelope.
          //
          // EVERY ARM REDACTS. This one used to be the single error path in this file that did
          // not, while quoting up to 400 chars of arbitrary CLI output — and a failing auth call
          // is exactly the one most likely to echo the credential it failed with.
          const exited = `the judge CLI exited ${r.code ?? 'on a signal'}`;
          const fromStderr = oneLine(r.stderr, 400);
          if (fromStderr !== '') return { error: `${exited} — ${redactSecrets(fromStderr)}` };
          if (r.stdout.trim() === '') return { error: exited };
          const parsed = parseJudgeEnvelope(r.stdout);
          // A non-zero exit is NEVER an answer, so a `text` reply here is a contradiction: the
          // envelope claims success and the process died. Report the text as the detail rather
          // than returning it as a verdict — a judgement that the CLI itself abandoned must not
          // be counted toward the quorum.
          const detail = answered(parsed) ? oneLine(redactSecrets(parsed.text), 400) : parsed.error;
          return { error: `${exited} — ${detail}` };
        }
        return parseJudgeEnvelope(r.stdout);
      } catch (e) {
        // `describeThrown`, not `e.message`: a wrapper's message routinely says nothing (Node's
        // fetch collapses every transport failure to `fetch failed`) and the fact worth having is
        // one `cause` down. Same defect as discarding a non-2xx body — bead `sparkle-dy8mu0`.
        return { error: describeThrown(e) };
      }
    },
  };
}
