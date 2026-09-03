/**
 * humaneTransport — WHERE A JUDGE ANSWER COMES FROM, as a plug rather than a hard-coded call.
 *
 * WHY THIS EXISTS (bead `sparkle-plmpnm`). The founder's ruling, verbatim: *"well actually, that
 * should be powered by our rotation fleet"*, sharpened by *"it should be able to tap into our
 * fleet for all the max plans"* and bounded by *"I don't want to be doing anything that's outside
 * of my Claude Max subscription."*
 *
 * Before this file, `run-gate.ts` called `api.anthropic.com` directly with an `ANTHROPIC_API_KEY`
 * read out of the environment. That is three separate problems in one line:
 *
 *   1. IT IS METERED API SPEND, which the founder has explicitly refused for these lanes.
 *   2. IT IS ONE HAND-SET CREDENTIAL, which solves neither expiry, exhaustion nor failover, and
 *      rots silently — measured: the `ANTHROPIC_API` secret was present in `gh secret list` and
 *      out of credit, so every judge call returned HTTP 400 and the gate published an honest
 *      `neutral` on every pull request for its entire life. It has never once produced a score.
 *   3. IT IS NOT PORTABLE. HumaneBench is meant to become a service other people can point at
 *      their own repositories, with their own agents. A scorer that can only be fed by one
 *      vendor's HTTP API and one environment variable cannot be that.
 *
 * ── THE SEAM ─────────────────────────────────────────────────────────────────────────────────
 * The whole interface is ONE FUNCTION: text in, text or an explanation out.
 *
 *     ask(prompt, model) => Promise<{ text } | { error }>
 *
 * That is deliberately the smallest thing that can be implemented by an HTTP client, a CLI
 * subprocess, a local model, a queue, or somebody else's agent entirely. THE PACKAGE NEVER HOLDS
 * A CREDENTIAL: whoever constructs the transport supplies the credential, so a multi-tenant
 * deployment gives each tenant their own and the service itself holds none. That is what makes
 * bring-your-own-credential the default rather than a feature.
 *
 * ── WHY A `{ error }` RETURN AND NEVER A THROW ───────────────────────────────────────────────
 * `humaneJudge` counts an ATTEMPT THAT DID NOT ANSWER separately from a low score, and below
 * quorum it publishes a non-blocking could-not-evaluate rather than inventing a number (founder
 * decision 2026-08-25; beads `sparkle-4xvu29`, `sparkle-g6cc8q`). A thrown exception would have to
 * be caught and re-classified at the call site by every implementation; returning the explanation
 * keeps the failure contract in the type. Implementations MUST NOT throw — catch and return.
 *
 * ── THE METERING SEAM, DELIBERATELY UNUSED TODAY ─────────────────────────────────────────────
 * `usage` rides back on a successful answer. Nothing reads it yet. It is here because the founder
 * chose "bring-your-own-credential now, metered later": `apps/orchestration/src/routes/ai.ts`
 * already implements reserve -> call -> reconcile against a Stripe-backed credit ledger, and that
 * pattern needs a token count from the call it is reconciling. Adding the field later would mean
 * changing every implementation at once; adding it now costs one optional property.
 */

import type { CredentialSource } from './humaneTypes.ts';

export type { CredentialSource } from './humaneTypes.ts';
export { CREDENTIAL_SOURCES } from './humaneTypes.ts';

/** What a judge call cost. Optional, unread today — see the metering-seam note above. */
export interface JudgeUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** A judge answered. `text` is the raw model output; parsing it is the caller's job. */
export interface JudgeAnswer {
  readonly text: string;
  readonly usage?: JudgeUsage;
}

/**
 * A judge did NOT answer, and why — in a sentence a human can act on.
 *
 * QUOTE THE PROVIDER'S OWN WORDS. `HTTP 400 Bad Request` names the symptom and hides the cause;
 * this gate reported exactly that for its entire life while the API was saying, in the body it
 * threw away, which field it was rejecting (bead `sparkle-g6cc8q`).
 */
export interface JudgeFailure {
  readonly error: string;
}

export type JudgeReply = JudgeAnswer | JudgeFailure;

/** Narrowing helper, so callers do not re-derive the discriminant. */
export function answered(reply: JudgeReply): reply is JudgeAnswer {
  return (reply as JudgeAnswer).text !== undefined;
}

/**
 * The plug. Implement this and HumaneBench can be driven by anything.
 *
 * `source` is provenance for the published verdict, NOT a switch — nothing branches on it, so a
 * new implementation never requires a change here or in the scorer.
 */
export interface JudgeTransport {
  readonly source: CredentialSource;
  /** A short human-readable name for logs, e.g. `fleet (rotation account 96cf06b9)`. */
  readonly describe: string;
  /** MUST NOT throw. Catch everything and return `{ error }`. */
  ask(prompt: string, model: string): Promise<JudgeReply>;
}

/**
 * The transport used when no judge may be called — `--no-model`, or no credential resolved.
 *
 * It is a REAL transport that always fails rather than a null the call site has to check, so the
 * "nothing answered" path runs the same code as the "everything answered" path. That is the path
 * that has run on every pull request for this gate's entire life, so it is the one most worth
 * exercising in production.
 */
export function unreachableTransport(why: string): JudgeTransport {
  return {
    source: 'none',
    describe: `no judge (${why})`,
    ask: async () => ({ error: why }),
  };
}

/**
 * A thrown value as ONE line that keeps the CAUSE, not just the outermost message.
 *
 * Node's `fetch` collapses EVERY transport failure into the opaque string `fetch failed` and puts
 * what actually happened somewhere underneath. Reporting the wrapper alone is the same defect as
 * discarding a non-2xx response body (bead `sparkle-dy8mu0`, which cost three investigations),
 * one level down the stack: every network failure the gate ever hits reads identically.
 *
 * THREE PLACES THE REAL REASON HIDES, and the second one is the shape production actually
 * produces:
 *
 *   `cause`   — the ordinary single-hop wrapper.
 *   `errors`  — an **AggregateError**. This is the endpoint case, not an exotic one:
 *               `api.anthropic.com` has both A and AAAA records, so Node's happy-eyeballs connect
 *               path (`autoSelectFamily`, default-on since Node 20) tries several addresses. When
 *               they all fail, `net` destroys the socket with an AggregateError whose message is
 *               the generic *"All attempts to connect failed"*, whose per-address `ECONNREFUSED` /
 *               `EHOSTUNREACH` errors live in `.errors`, and whose `.cause` is UNDEFINED. Walking
 *               `cause` alone terminates right there and publishes
 *               `fetch failed: All attempts to connect failed` — no specific cause at all.
 *   `code`    — Node system errors carry the machine-readable code as a property, not in the
 *               message. It is the most actionable token in the whole chain.
 *
 * A test that hand-builds a plain `Error` cause, or that connects to a LITERAL IP, cannot see the
 * aggregate case: both bypass DNS and happy-eyeballs entirely. `humaneTransport.test.ts` therefore
 * constructs a real AggregateError, and the shell contract test points at a HOSTNAME.
 *
 * Bounded at five links, with a `seen` set, because a cause chain can be cyclic and this runs
 * inside a judge loop where a hang is indistinguishable from a slow model.
 */
export function describeThrown(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const parts: string[] = [];
  const seen = new Set<unknown>();
  // `unknown`, and coerced HERE, at the single choke point.
  //
  // `code` is read off an arbitrary thrown value through a cast, and errors with a NUMERIC code
  // exist and are `instanceof Error`: DOMException carries the legacy numeric code (20 for
  // AbortError), and exec-shaped errors use an exit number. `(20).trim` is not a function, so the
  // unguarded version threw FROM INSIDE THE CATCH BLOCK — breaking this interface's central
  // promise that a transport never throws, and converting the founder-mandated fail-open into an
  // unhandled rejection. This helper is careful about cycles, depth and non-Error inputs; the one
  // property it read off an untyped object was the one it trusted.
  const push = (v: unknown): void => {
    if (v === undefined || v === null) return;
    const t = (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').trim();
    if (t && !parts.includes(t)) parts.push(t);
  };

  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur instanceof Error && !seen.has(cur); depth++) {
    seen.add(cur);
    push(cur.message);
    // The code is a PROPERTY, never in the message, and it is the token worth grepping for.
    push((cur as { code?: string }).code);

    // Fold an AggregateError's own children in before following `cause` — for that shape `cause`
    // is undefined, so without this the walk simply stops holding nothing useful. Two entries is
    // enough: happy-eyeballs failures are near-identical per address, and the depth bound still
    // governs the outer walk.
    const nested = (cur as { errors?: unknown }).errors;
    if (Array.isArray(nested)) {
      for (const child of nested.slice(0, 2)) {
        if (child instanceof Error && !seen.has(child)) {
          seen.add(child);
          push(child.message);
          push((child as { code?: string }).code);
        }
      }
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(': ') || String(e);
}
