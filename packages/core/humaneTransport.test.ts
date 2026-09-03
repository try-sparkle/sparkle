/**
 * The judge transport seam (bead `sparkle-plmpnm`).
 *
 * WHAT THESE TESTS ARE FOR. The transport is the one place a credential is chosen, and the two
 * ways it can be wrong are both SILENT:
 *   * it bills a metered API key instead of the subscription (the founder's spend rule, broken by
 *     an env var nobody meant to pass through), and
 *   * it reports "no model was reachable" while throwing away the sentence that said why — the
 *     defect that kept this gate inert for its entire life (`sparkle-g6cc8q`).
 * So the assertions below are on the ARGV, the CHILD ENV and the ERROR TEXT, not on whether a
 * function ran.
 */
import { describe, expect, it } from 'vitest';
import { answered, CREDENTIAL_SOURCES, describeThrown, unreachableTransport } from './humaneTransport.ts';
import {
  ALLOWED_CLI_FLAGS,
  API_KEY_VARS,
  assertKnownFlags,
  buildJudgeArgs,
  claudeCliTransport,
  judgeChildEnv,
  makeRunCli,
  oneLine,
  parseJudgeEnvelope,
} from './humaneTransportClaudeCli.ts';
import {
  accountLabel,
  classifyFleetResult,
  FLEET_EXIT,
  fleetTransport,
} from './humaneTransportFleet.ts';

const ok = (result: string, usage?: unknown): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, usage });

describe('the transport contract', () => {
  it('narrows an answer from a failure', () => {
    expect(answered({ text: 'hi' })).toBe(true);
    expect(answered({ error: 'nope' })).toBe(false);
  });

  it('carries exactly the six credential sources', () => {
    // Asserted against the exported list itself rather than through a validator function. The
    // validator existed only for this test — nothing in production ever checked a source at
    // runtime — and an export whose only importer is its own test is a dormant export, which this
    // repository fails the build over. The list IS the contract; assert on the contract.
    expect([...CREDENTIAL_SOURCES].sort()).toEqual(
      ['api-key', 'fleet', 'local-login', 'none', 'oauth-token', 'stub'].sort(),
    );
    // The fiction this replaced. If `openrouter` is ever a source again, something has
    // re-introduced a provenance label for a provider no code in this repository can reach.
    expect(CREDENTIAL_SOURCES).not.toContain('openrouter');
    expect(CREDENTIAL_SOURCES).not.toContain('subscription');
  });

  it('the unreachable transport ANSWERS with its reason rather than throwing', async () => {
    const t = unreachableTransport('the fleet stood down');
    await expect(t.ask('p', 'm')).resolves.toEqual({ error: 'the fleet stood down' });
    expect(t.source).toBe('none');
  });
});

describe('the headless invocation', () => {
  it('puts the variadic --tools LAST, so nothing can be swallowed as a tool name', () => {
    const args = buildJudgeArgs('claude-sonnet-5');
    expect(args[args.length - 2], 'the penultimate arg must be --tools').toBe('--tools');
    expect(args[args.length - 1], 'the final arg must be its empty value').toBe('');
  });

  it('strips user-level settings, so the judged prompt does not depend on whose machine ran it', () => {
    const args = buildJudgeArgs('m');
    const i = args.indexOf('--setting-sources');
    expect(i, '--setting-sources must be present').toBeGreaterThan(-1);
    expect(args[i + 1], 'it must be set to the empty string').toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
  });

  it('never passes --bare, which would force metered API-key auth', () => {
    // The founder's rule: nothing outside the Max subscription. `--bare` strips settings the same
    // way `--setting-sources ''` does, but silently switches the billing path.
    expect(buildJudgeArgs('m')).not.toContain('--bare');
  });

  it('sends NO flag outside the proven set — the guard for `unknown option`', () => {
    // A flag the CLI does not know exits 1 on every call and reaches the gate as "the judge did
    // not answer" on every turn, which is indistinguishable from a dead credential in a CI log.
    // Measured: `--max-output-tokens` is a Messages-API parameter and NOT a CLI flag, and it
    // failed all six judge calls of the first real fleet run.
    const sent = buildJudgeArgs('m').filter((a) => a.startsWith('-') && a !== '-');
    for (const flag of sent) {
      expect(ALLOWED_CLI_FLAGS, `${flag} is not a flag the pinned CLI is known to accept`).toContain(flag);
    }
  });

  it('assertKnownFlags REFUSES an unknown flag at runtime, naming it', () => {
    // The runtime half of the guard above. A test catches an unknown flag only where the test
    // runs; this makes shipping one impossible. `--max-output-tokens` is the real case — a
    // Messages-API parameter, not a CLI flag, which failed all six judge calls of the first
    // real fleet run and read in the log as a dead credential.
    expect(() => assertKnownFlags(['-p', '--model', 'm'])).not.toThrow();
    expect(() => assertKnownFlags(['-p', '--max-output-tokens', '4096'])).toThrow(/max-output-tokens/);
  });

  it('every flag buildJudgeArgs emits passes its own runtime guard', () => {
    expect(() => assertKnownFlags(buildJudgeArgs('claude-sonnet-5'))).not.toThrow();
  });

  it('asks for the model it was given', () => {
    const args = buildJudgeArgs('claude-haiku-4-5');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5');
  });
});

describe('the child environment', () => {
  it('WITHHOLDS every API-key variable even when the parent has them set', () => {
    const parent: Record<string, string | undefined> = { HOME: '/h', PATH: '/b' };
    for (const k of API_KEY_VARS) parent[k] = 'sk-should-never-reach-the-child';
    const env = judgeChildEnv(parent);
    for (const k of API_KEY_VARS) {
      expect(env[k], `${k} must never reach the judge subprocess`).toBeUndefined();
    }
    expect(env.HOME).toBe('/h');
  });

  it('WITHHOLDS unrelated secrets from the parent environment', () => {
    const env = judgeChildEnv({
      HOME: '/h',
      DATABASE_URL: 'postgres://production',
      GH_TOKEN: 'ghp_secret',
      AWS_SECRET_ACCESS_KEY: 'aws',
    });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('passes an inherited subscription credential through when NO account was selected', () => {
    // No `configDir` argument: nothing chose an account, so whatever the environment carries is
    // what should answer. This is the CI shape.
    const env = judgeChildEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oat', CLAUDE_CONFIG_DIR: '/a/b' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/a/b');
  });

  it('a SELECTED account SCRUBS an inherited OAuth token — they are mutually exclusive', () => {
    // THIS TEST REPLACES ONE THAT PINNED THE DEFECT. The previous version asserted both variables
    // survived together and called that "passes the subscription credentials through" — which is
    // precisely the bug: Claude Code prefers the env token over the config dir's stored session,
    // so the fleet would pick an account, export it, and every call would still bill the one
    // hand-set token. Rotation silently does nothing, a dead token fails all judges even though a
    // live account was chosen, and the verdict still says `lane: fleet`.
    const env = judgeChildEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oat' }, '/accts/96cf06b9');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/accts/96cf06b9');
    expect(
      'CLAUDE_CODE_OAUTH_TOKEN' in env,
      'a chosen account must not be overridden by an inherited token',
    ).toBe(false);
  });

  it('the machine-default sentinel KEEPS an inherited token — nothing was chosen to conflict', () => {
    // The token is what will authenticate here, and that is fine — but the PROVENANCE must then
    // say `oauth-token`, not `local-login`. That pairing is asserted in the fleet-resolver block
    // below; this only pins that the token is not needlessly scrubbed when no account was chosen.
    const env = judgeChildEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oat' }, '');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat');
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
  });

  it("the fleet's selection OVERRIDES an inherited config dir", () => {
    const env = judgeChildEnv({ CLAUDE_CONFIG_DIR: '/inherited' }, '/selected');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/selected');
  });

  it('the machine-default sentinel UNSETS the variable rather than setting it empty', () => {
    // An empty CLAUDE_CONFIG_DIR is not "use the default" — it is a path that does not exist.
    const env = judgeChildEnv({ CLAUDE_CONFIG_DIR: '/inherited' }, '');
    expect('CLAUDE_CONFIG_DIR' in env, 'the key must be absent, not empty').toBe(false);
  });
});

describe('reading the CLI envelope', () => {
  it('returns the result text', () => {
    expect(parseJudgeEnvelope(ok('{"scores":[]}'))).toEqual({ text: '{"scores":[]}' });
  });

  it('scans from the END, past a warning line the CLI printed first', () => {
    const out = `{"note":"this is not the envelope"}\nsome warning\n${ok('the answer')}`;
    expect(parseJudgeEnvelope(out)).toEqual({ text: 'the answer' });
  });

  it('carries usage back for the metering seam', () => {
    const r = parseJudgeEnvelope(ok('x', { input_tokens: 12, output_tokens: 3 }));
    expect(r).toEqual({ text: 'x', usage: { inputTokens: 12, outputTokens: 3 } });
  });

  it('reports an is_error envelope with the CLI OWN WORDS, not a generic message', () => {
    const out = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Claude Code error (success 401): Failed to authenticate. API Error: 401 OAuth access token is invalid.',
    });
    const r = parseJudgeEnvelope(out);
    expect(answered(r)).toBe(false);
    // The whole point of bead sparkle-g6cc8q: quote the cause, never just the symptom.
    expect((r as { error: string }).error).toContain('401 OAuth access token is invalid');
  });

  it('QUOTES non-JSON output instead of discarding it', () => {
    const r = parseJudgeEnvelope('Not logged in · Please run /login');
    expect((r as { error: string }).error).toContain('Not logged in');
  });

  it('says so when the CLI produced nothing at all', () => {
    expect((parseJudgeEnvelope('   ') as { error: string }).error).toContain('no output');
  });

  it('refuses an envelope whose result is empty rather than scoring a blank answer', () => {
    expect(answered(parseJudgeEnvelope(ok('   ')))).toBe(false);
  });

  it('oneLine flattens and bounds, so one failure stays one log line', () => {
    expect(oneLine('a\n\n  b   c ', 100)).toBe('a b c');
    expect(oneLine('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}...`);
  });
});

describe('the CLI transport', () => {
  const transport = (runCli: Parameters<typeof claudeCliTransport>[0]['runCli']) =>
    claudeCliTransport({ source: 'fleet', describe: 'test', env: {}, runCli });

  it('returns the answer on a clean run', async () => {
    const t = transport(async () => ({ code: 0, stdout: ok('scored'), stderr: '' }));
    await expect(t.ask('p', 'm')).resolves.toEqual({ text: 'scored' });
  });

  it('reports a non-zero exit WITH the stderr, and does not throw', async () => {
    const t = transport(async () => ({ code: 1, stdout: '', stderr: 'Credit balance is too low' }));
    const r = await t.ask('p', 'm');
    expect(answered(r)).toBe(false);
    expect((r as { error: string }).error).toContain('Credit balance is too low');
  });

  it('reports a spawn failure rather than throwing', async () => {
    const t = transport(async () => ({ code: null, stdout: '', stderr: '', spawnError: 'spawn claude ENOENT' }));
    await expect(t.ask('p', 'm')).resolves.toEqual({ error: 'spawn claude ENOENT' });
  });

  it('NEVER throws, even when the runner itself throws', async () => {
    const t = transport(async () => {
      throw new Error('the runner exploded');
    });
    const r = await t.ask('p', 'm');
    expect(answered(r)).toBe(false);
    expect((r as { error: string }).error).toContain('exploded');
  });

  it('sends the prompt and the model through to the runner', async () => {
    let seenPrompt = '';
    let seenArgs: string[] = [];
    const t = transport(async (args, _env, prompt) => {
      seenArgs = args;
      seenPrompt = prompt;
      return { code: 0, stdout: ok('x'), stderr: '' };
    });
    await t.ask('THE RUBRIC PROMPT', 'claude-opus-5');
    expect(seenPrompt).toBe('THE RUBRIC PROMPT');
    expect(seenArgs[seenArgs.indexOf('--model') + 1]).toBe('claude-opus-5');
  });

  it('the DEFAULT runner really spawns a process — the seam every other test injects past', async () => {
    // Bead sparkle-lgbwf: when every test supplies its own runner, the line that builds the real
    // one is covered by nothing, and deleting it leaves the suite green. This drives makeRunCli
    // against a real binary.
    const run = makeRunCli('/bin/echo');
    const r = await run([ok('from a real process')], {}, '', 10_000);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('from a real process');
  });

  it('the default runner reports a missing binary rather than throwing', async () => {
    const run = makeRunCli('/nonexistent/definitely-not-a-binary');
    const r = await run([], {}, '', 10_000);
    expect(r.code).toBe(null);
    expect(r.spawnError ?? '').toMatch(/ENOENT|not found|no such file/i);
  });
});

describe('the fleet resolver', () => {
  it('a selected account is the config dir on stdout', () => {
    expect(classifyFleetResult({ status: 0, stdout: '/a/accounts/9cf0\n', stderr: '' })).toEqual({
      ok: true,
      configDir: '/a/accounts/9cf0',
    });
  });

  it('exit 0 with EMPTY stdout is a real selection — the machine-default login', () => {
    // Not a failure. Mistaking this for "nothing selected" would disable the fallback entirely.
    expect(classifyFleetResult({ status: 0, stdout: '', stderr: '' })).toEqual({ ok: true, configDir: '' });
  });

  it('STANDDOWN is a policy refusal and says so by name', () => {
    const r = classifyFleetResult({ status: FLEET_EXIT.STANDDOWN, stdout: '', stderr: '' });
    expect(r.ok).toBe(false);
    expect((r as { why: string }).why).toContain('STOOD DOWN');
  });

  it('COULD-NOT-LOOK is never reported as a clean result', () => {
    const r = classifyFleetResult({ status: FLEET_EXIT.COULD_NOT_LOOK, stdout: '', stderr: '' });
    expect(r.ok).toBe(false);
    expect((r as { why: string }).why).toContain('COULD-NOT-LOOK');
  });

  it('an unrecognised exit is a refusal that quotes stderr', () => {
    const r = classifyFleetResult({ status: 42, stdout: '', stderr: 'bash: bad thing' });
    expect(r.ok).toBe(false);
    expect((r as { why: string }).why).toContain('bad thing');
  });

  it('a stood-down fleet yields a transport that ANSWERS with the reason', async () => {
    const t = fleetTransport({
      scriptPath: '/unused',
      runFleetScript: () => ({ status: FLEET_EXIT.STANDDOWN, stdout: '', stderr: '' }),
    });
    expect(t.source).toBe('none');
    const r = await t.ask('p', 'm');
    expect((r as { error: string }).error).toContain('STOOD DOWN');
  });

  it('a selected account yields a fleet transport bound to that config dir', async () => {
    let seenEnv: Record<string, string> = {};
    const t = fleetTransport({
      scriptPath: '/unused',
      env: {},
      runFleetScript: () => ({ status: 0, stdout: '/accts/96cf06b9', stderr: '' }),
      runCli: async (_a, env) => {
        seenEnv = env;
        return { code: 0, stdout: ok('judged'), stderr: '' };
      },
    });
    expect(t.source).toBe('fleet');
    await t.ask('p', 'm');
    expect(seenEnv.CLAUDE_CONFIG_DIR).toBe('/accts/96cf06b9');
  });

  it('the provenance label names the account WITHOUT leaking the machine path', () => {
    const t = fleetTransport({
      scriptPath: '/unused',
      runFleetScript: () => ({ status: 0, stdout: '/Users/someone/Library/App Support/accounts/96cf06b9', stderr: '' }),
      runCli: async () => ({ code: 0, stdout: ok('x'), stderr: '' }),
    });
    expect(t.describe).toContain('96cf06b9');
    expect(t.describe).not.toContain('/Users/');
  });

  it('an UNSELECTED account is NOT reported as a fleet', async () => {
    // Exit 0 with empty stdout means "no specific account — use the machine default". On a CI
    // runner this is the NORMAL path, not an edge case: the gate is checked out from the default
    // branch, so the fleet SCRIPT exists even where no fleet does. Claiming `fleet` there would
    // render `Judged via: fleet` on a box with no rotation accounts — the same lying-provenance
    // defect as the `openrouter` value this type replaced.
    const t = fleetTransport({
      scriptPath: '/unused',
      env: {},
      runFleetScript: () => ({ status: 0, stdout: '', stderr: '' }),
      runCli: async () => ({ code: 0, stdout: ok('x'), stderr: '' }),
    });
    expect(t.source, 'a machine-default login is not a fleet selection').toBe('local-login');
    expect(t.source).not.toBe('fleet');
    expect(t.describe).toContain('machine default');
  });

  it('names the TOKEN when one is inherited and no account was selected', () => {
    // Provenance must follow what will actually AUTHENTICATE. With no account chosen the child
    // inherits CLAUDE_CODE_OAUTH_TOKEN, and Claude Code prefers that token over any stored
    // session — so calling the run a "machine default login" would describe it as something it is
    // not, while the hand-set token is what answered. Same false-provenance defect as
    // `openrouter`, one branch over.
    const t = fleetTransport({
      scriptPath: '/unused',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat' },
      runFleetScript: () => ({ status: 0, stdout: '', stderr: '' }),
      runCli: async () => ({ code: 0, stdout: ok('x'), stderr: '' }),
    });
    expect(t.source, 'the token is what will answer, so the token is the provenance').toBe('oauth-token');
    expect(t.source).not.toBe('local-login');
  });

  it('a SELECTED account still wins over an inherited token, and scrubs it', async () => {
    let seenEnv: Record<string, string> = {};
    const t = fleetTransport({
      scriptPath: '/unused',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat' },
      runFleetScript: () => ({ status: 0, stdout: '/accts/abc123', stderr: '' }),
      runCli: async (_a, env) => {
        seenEnv = env;
        return { code: 0, stdout: ok('x'), stderr: '' };
      },
    });
    expect(t.source).toBe('fleet');
    await t.ask('p', 'm');
    expect(seenEnv.CLAUDE_CONFIG_DIR).toBe('/accts/abc123');
    expect(
      'CLAUDE_CODE_OAUTH_TOKEN' in seenEnv,
      'a chosen account must not be silently overridden by the token',
    ).toBe(false);
  });

  it('accountLabel returns the basename only', () => {
    expect(accountLabel('/Users/x/Library/accounts/abc123')).toBe('abc123');
    expect(accountLabel('')).toBe('unknown');
  });
});

describe('describeThrown — keeping the cause, not just the wrapper', () => {
  it('unwraps a cause chain that the outer message hides', () => {
    // Node's fetch collapses EVERY transport failure to `fetch failed` and puts what actually
    // happened in `cause`. Reporting the wrapper alone makes every network failure read
    // identically — the same information loss as discarding a non-2xx body (`sparkle-dy8mu0`).
    const inner = new Error('connect ECONNREFUSED 127.0.0.1:65276');
    const outer = new Error('fetch failed', { cause: inner });
    const out = describeThrown(outer);
    expect(out).toContain('fetch failed');
    expect(out, 'the cause is the half worth having').toContain('ECONNREFUSED');
  });

  it('survives an AggregateError — THE shape the real hostname endpoint produces', () => {
    // NOT an exotic case. `api.anthropic.com` has A and AAAA records, so Node's happy-eyeballs
    // connect path tries several addresses; when all fail, `net` destroys the socket with an
    // AggregateError whose message is the generic "All attempts to connect failed", whose
    // per-address errors live in `.errors`, and whose `.cause` is UNDEFINED. A cause-only walk
    // stops there and publishes no specific reason — the exact information loss this exists to
    // prevent. A hand-built plain-Error cause cannot detect this, which is why the previous
    // version of this suite was green over the bug.
    const perAddress = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), {
      code: 'ECONNREFUSED',
    });
    const agg = new AggregateError([perAddress], 'All attempts to connect failed');
    const out = describeThrown(new Error('fetch failed', { cause: agg }));
    expect(out).toContain('fetch failed');
    expect(out, 'the per-address cause must survive the aggregate').toContain('ECONNREFUSED');
    expect(out).toContain('1.2.3.4:443');
  });

  it("carries a Node system error's `code`, which never appears in the message", () => {
    const e = Object.assign(new Error('connect failed'), { code: 'EHOSTUNREACH' });
    expect(describeThrown(e)).toContain('EHOSTUNREACH');
  });

  it('bounds a large AggregateError rather than pasting every address into one log line', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      Object.assign(new Error(`connect ECONNREFUSED 10.0.0.${i}:443`), { code: 'ECONNREFUSED' }),
    );
    const out = describeThrown(new Error('fetch failed', { cause: new AggregateError(many, 'all failed') }));
    expect(out).toContain('10.0.0.0:443');
    expect(out, 'a failure must stay ONE readable line').not.toContain('10.0.0.5:443');
  });

  it('terminates on a CYCLIC aggregate, not just a cyclic cause', () => {
    const a = new Error('a');
    const agg = new AggregateError([a], 'agg');
    (a as { cause?: unknown }).cause = agg;
    expect(() => describeThrown(a)).not.toThrow();
    expect(describeThrown(a)).toContain('a');
  });

  it('does not repeat a cause that merely echoes its wrapper', () => {
    const e = new Error('same', { cause: new Error('same') });
    expect(describeThrown(e)).toBe('same');
  });

  it('terminates on a CYCLIC cause chain rather than hanging a judge call', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(describeThrown(a)).toBe('a: b');
  });

  it('does NOT throw on a numeric `code` — it runs inside a catch that must not throw', () => {
    // DOMException carries the LEGACY NUMERIC code (20 for AbortError) and is `instanceof Error`;
    // exec-shaped errors use an exit number. `(20).trim` is not a function, so reading `code`
    // unguarded threw from inside the very catch block whose contract is "never throw" — turning
    // the founder-mandated fail-open into an unhandled rejection. The helper was careful about
    // cycles, depth and non-Error inputs, and trusted the one property it read off an untyped
    // object.
    const numeric = Object.assign(new Error('the judge aborted'), { code: 20 });
    expect(() => describeThrown(numeric)).not.toThrow();
    expect(describeThrown(numeric)).toContain('the judge aborted');
    expect(describeThrown(numeric), 'a numeric code is still worth carrying').toContain('20');
  });

  it('ignores a `code` that is neither string nor number rather than throwing', () => {
    const weird = Object.assign(new Error('boom'), { code: { nested: true } });
    expect(() => describeThrown(weird)).not.toThrow();
    expect(describeThrown(weird)).toBe('boom');
  });

  it('survives a numeric code nested inside an AggregateError', () => {
    const child = Object.assign(new Error('inner'), { code: 20 });
    const agg = new AggregateError([child], 'all failed');
    expect(() => describeThrown(new Error('fetch failed', { cause: agg }))).not.toThrow();
  });

  it('handles a thrown non-Error', () => {
    expect(describeThrown('a bare string')).toBe('a bare string');
  });
});
