/**
 * humaneTransportFleet — select a LIVE Claude account from the rotation fleet, at call time.
 *
 * THE FOUNDER'S RULING (bead `sparkle-plmpnm`), verbatim: *"well actually, that should be powered
 * by our rotation fleet"*, and *"it should be able to tap into our fleet for all the max plans."*
 *
 * WHY A FLEET AND NOT A TOKEN, with today's measurement rather than an argument. A hand-set
 * `CLAUDE_CODE_OAUTH_TOKEN` was added to this repository's secrets on 2026-08-26 as an explicit
 * BRIDGE. On 2026-09-02 — seven days later — it answered `401 OAuth access token is invalid` (run
 * 33677871810), having already re-frozen the changelog. The 2026-08-10 token before it did the
 * same thing. A single credential solves neither expiry, exhaustion nor failover, and it rots
 * SILENTLY: `gh secret list` reports it present throughout. The fleet is not a nicer way to hold a
 * credential; it is the only shape that survives the credential dying.
 *
 * ── THIS FILE IS A RESOLVER, NOT A TRANSPORT ─────────────────────────────────────────────────
 * Selection and invocation are kept apart on purpose. `humaneTransportClaudeCli` knows how to CALL
 * a judge; this knows WHICH account to call it as. Composed, they are the fleet transport — and a
 * future server-side fleet (per-tenant credentials in `user_claude_credentials`) is a different
 * resolver in front of the same unchanged transport.
 *
 * ── WHY THE POLICY REFUSAL IS HONOURED, NOT OVERRIDDEN ───────────────────────────────────────
 * `scripts/claude-fleet.sh` exits 78 STANDDOWN when fewer than two accounts are usable, leaving
 * the last one for the founder's interactive work. A scorer is BACKGROUND work: it must never be
 * the thing that takes the founder's last account. So 78 is reported as a could-not-evaluate — the
 * gate publishes a non-blocking neutral saying the fleet stood down, which is honest and costs
 * nothing. It is deliberately NOT retried and NOT overridden.
 */
import { execFileSync } from 'node:child_process';
import { claudeCliTransport, type RunCli } from './humaneTransportClaudeCli.ts';
import { unreachableTransport, type JudgeTransport } from './humaneTransport.ts';

/** `claude-fleet.sh`'s verdict space. Only 0 is a selection. */
export const FLEET_EXIT = {
  SELECTED: 0,
  /** No account we could find can authenticate. Never "clean", never an empty success. */
  COULD_NOT_LOOK: 3,
  USAGE: 4,
  /** Policy refusal: the fleet was read successfully and answered "do not run". */
  STANDDOWN: 78,
} as const;

export type FleetSelection =
  /** `configDir` is the account to use; EMPTY STRING means the machine-wide default login. */
  | { readonly ok: true; readonly configDir: string }
  | { readonly ok: false; readonly why: string };

/** Injectable so the suite drives the real classification without a real fleet on disk. */
export interface RunFleetScript {
  (scriptPath: string): { status: number; stdout: string; stderr: string };
}

export const defaultRunFleetScript: RunFleetScript = (scriptPath) => {
  try {
    const stdout = execFileSync('bash', [scriptPath, '--quiet'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      // A missing bash or unreadable script has no exit status at all. Treat that as
      // COULD-NOT-LOOK rather than inventing a selection: the whole point of this module is that
      // "could not ask" is never rendered as "nothing wrong".
      status: typeof err.status === 'number' ? err.status : FLEET_EXIT.COULD_NOT_LOOK,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
    };
  }
};

/**
 * Classify the fleet script's answer.
 *
 * EVERY non-zero exit is a refusal to select, and each says something different to a human, so
 * they are not collapsed. Note that exit 0 with EMPTY stdout is a real selection — the
 * machine-default login — and must not be mistaken for "nothing was selected".
 */
export function classifyFleetResult(r: { status: number; stdout: string; stderr: string }): FleetSelection {
  switch (r.status) {
    case FLEET_EXIT.SELECTED:
      return { ok: true, configDir: r.stdout.trim() };
    case FLEET_EXIT.STANDDOWN:
      return {
        ok: false,
        why:
          'the account rotation fleet STOOD DOWN — fewer than two accounts are usable, so the last ' +
          'one is reserved for interactive work. Scoring is background work and does not take it.',
      };
    case FLEET_EXIT.COULD_NOT_LOOK:
      return {
        ok: false,
        why:
          'the account rotation fleet could not find any account that authenticates. This is a ' +
          'COULD-NOT-LOOK, not a clean result: nothing was scored.',
      };
    case FLEET_EXIT.USAGE:
      return { ok: false, why: 'the fleet selector rejected its own invocation (usage error)' };
    default: {
      const detail = r.stderr.replace(/\s+/g, ' ').trim().slice(0, 200);
      return {
        ok: false,
        why: `the fleet selector exited ${r.status}${detail ? ` — ${detail}` : ''}`,
      };
    }
  }
}

export interface FleetTransportOptions {
  /** Path to `scripts/claude-fleet.sh`. */
  readonly scriptPath: string;
  readonly binary?: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly runFleetScript?: RunFleetScript;
  readonly runCli?: RunCli;
}

/**
 * Resolve an account NOW and return a transport bound to it.
 *
 * Selection happens ONCE per gate run, not once per judge call: re-selecting per call would let a
 * single pull request be scored by several different accounts, which makes an ensemble
 * disagreement impossible to attribute. If the selected account dies mid-run its calls fail and
 * are counted as attempts that did not answer — the quorum rule already handles that honestly.
 */
export function fleetTransport(opts: FleetTransportOptions): JudgeTransport {
  const run = opts.runFleetScript ?? defaultRunFleetScript;
  const selection = classifyFleetResult(run(opts.scriptPath));
  if (!selection.ok) return unreachableTransport(selection.why);
  // AN UNSELECTED ACCOUNT IS NOT A FLEET. Exit 0 with empty stdout means "no specific account —
  // use the machine default", which is a different credential pool with a different remedy when it
  // stops working. Claiming `fleet` for it would put a value in every published verdict that names
  // a pool the run never touched; on CI that is the NORMAL path, because the gate is checked out
  // from the default branch and so the fleet SCRIPT exists even where no fleet does.
  const selected = selection.configDir !== '';
  // PROVENANCE FOLLOWS WHAT WILL ACTUALLY AUTHENTICATE, never what the resolver happened to return.
  //
  // With no account selected, the child inherits `CLAUDE_CODE_OAUTH_TOKEN` — and Claude Code
  // PREFERS that token over any stored session, which is this module's whole premise. So calling
  // the run a `local-login` when a token is present would describe it as "the machine default
  // login" while the hand-set token is what answered: the same false-provenance defect as
  // `openrouter`, one branch over. Name the token, because the token is what a human would have
  // to re-mint when it stops working.
  const env = opts.env ?? process.env;
  const inheritedToken = !selected && Boolean(env.CLAUDE_CODE_OAUTH_TOKEN);
  return claudeCliTransport({
    source: selected ? 'fleet' : inheritedToken ? 'oauth-token' : 'local-login',
    describe: selected
      ? `fleet (account ${accountLabel(selection.configDir)})`
      : inheritedToken
        ? 'subscription OAuth token (the fleet enumerated no account)'
        : 'the machine default login (the fleet enumerated no account)',
    configDir: selection.configDir,
    binary: opts.binary,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    runCli: opts.runCli,
  });
}

/**
 * The account's directory NAME only — never its full path.
 *
 * The label is printed into CI logs and into the published verdict's provenance line. A full path
 * carries the machine's user name and directory layout into a public artifact for no benefit; the
 * basename is enough to tell two accounts apart, which is the only thing a reader needs.
 */
export function accountLabel(configDir: string): string {
  const parts = configDir.split('/').filter(Boolean);
  return parts.length === 0 ? 'unknown' : (parts[parts.length - 1] as string);
}
