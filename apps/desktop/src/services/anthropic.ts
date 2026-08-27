// apps/desktop/src/services/anthropic.ts
// Frontend bindings for the Claude chat sink. `anthropic_chat` runs on the USER'S OWN Claude Code
// subscription, by shelling out to their authenticated `claude` CLI (src-tauri/src/claude_oneshot.rs).
// It previously proxied through the orchestration `POST /ai/anthropic` route on a Sparkle-funded
// vendor key metered at 10x — that key ran out of credit on 2026-07-28 and took every AI feature
// down at once. Tauri maps the Rust `max_tokens` arg to JS `maxTokens`.
//
// TWO THINGS FOLLOW, and they pull in opposite directions:
//
//   • The local credit gate is GONE (`assertAiCredits`), along with the `insufficient_credits`
//     branch. Refusing these calls on a Sparkle balance would disable a feature that spends no
//     Sparkle money — and with the vendor key retired it is a gate no top-up could ever satisfy.
//
//   • The provider-outage machinery is KEPT, and repointed. It was built for the same incident
//     (see stores/aiProviderStore.ts) to end exactly this silence, and that need did not go away —
//     it changed shape. The question is no longer "is Sparkle's vendor account funded?" but "can we
//     reach the user's own Claude CLI, and is it signed in?". Same store, same banner, same
//     every-wrapper reporting contract; new reasons.
import { invoke } from "@tauri-apps/api/core";
import { useConnectionStore } from "../stores/connectionStore";
import { useAiProviderStore, type AiProviderOutageReason } from "../stores/aiProviderStore";
import { useAiServiceHealthStore } from "../stores/aiServiceHealthStore";
import { oneshotFailoverConfigDir } from "./accountSelection";

/**
 * The request never reached the proxy: no HTTP status came back because this machine has no working
 * network path (DNS failure, connect/TLS timeout, socket error). Distinct from a server-side
 * rejection — nothing about the request is wrong, so callers should DEFER rather than burn a retry
 * budget on paid calls that cannot succeed. Extends Error, so existing generic catches still work.
 */
export class AiUnreachableError extends Error {
  constructor() {
    super("Claude request failed: the network is unreachable");
    this.name = "AiUnreachableError";
  }
}

/**
 * The AI backend is unusable for an ENVIRONMENTAL reason, not because this request is wrong:
 * identical retries stay doomed until something outside the request changes. Modelled like being
 * offline — callers defer rather than spend a retry budget.
 *
 * `reason` names WHY, and drives the banner copy (see ProviderUnavailableBanner). It is null for the
 * shapes that carry no reason. Callers that merely need to defer should keep branching on the TYPE.
 *
 * `message` is settable so the subclasses below can say WHAT TO FIX while every existing
 * `instanceof AiUnavailableError` defer path keeps working unchanged. That combination is the point:
 * the lesson of 2026-07-28 is that a silently-degrading AI feature reads as a bug in something else,
 * so these must be able to name both the cause and the remedy.
 */
export class AiUnavailableError extends Error {
  readonly reason: AiProviderOutageReason | null;
  constructor(reason: AiProviderOutageReason | null = null, message?: string) {
    super(message ?? (reason ? `AI backend is unavailable: ${reason}` : "AI backend is unavailable"));
    this.reason = reason;
    this.name = "AiUnavailableError";
  }
}

/** `claude` is not on PATH — Claude Code isn't installed. Sparkle's AI features run on the user's
 *  subscription, so there is nothing to fall back to; the fix is an install, not a retry. */
export class ClaudeMissingError extends AiUnavailableError {
  constructor() {
    super("cli_missing", "Sparkle's AI features need the Claude Code CLI — install it to turn them on");
    this.name = "ClaudeMissingError";
  }
}

/** The CLI is installed but not signed in. Deferrable for the same reason: every retry fails
 *  identically until the user runs `claude` and logs in. */
export class ClaudeAuthError extends AiUnavailableError {
  constructor() {
    super("cli_not_authenticated", "Sign in to Claude Code to turn Sparkle's AI features back on");
    this.name = "ClaudeAuthError";
  }
}

/** The user's Claude subscription hit its usage limit for this window — the subscription analogue of
 *  the old out-of-credits path. It recovers on its own, so it points at waiting, not at a top-up. */
export class ClaudeUsageLimitError extends AiUnavailableError {
  constructor() {
    super("usage_limit", "Claude usage limit reached — Sparkle's AI features will resume when it resets");
    this.name = "ClaudeUsageLimitError";
  }
}

/**
 * The local concurrency pool was saturated: the call was refused BEFORE anything was spawned.
 *
 * `ai_busy` ONLY, and the narrowness is the whole point. Callers exempt this class from their
 * bounded attempt budgets, which is only defensible because the refusal is genuinely FREE — no
 * `claude` child ran, no quota was spent — and time-CORRELATED, so three can arrive inside a few
 * seconds from one burst and would otherwise exhaust a budget that exists to stop PAID retries.
 *
 * `ai_timeout` deliberately does NOT belong here, and grouping the two was a real bug: a timeout is
 * produced only after `output_with_timeout` has forked the CLI and let it run the FULL wall clock
 * (60s classify, 180s chat) before killing the process group. That call spent the user's quota, and
 * unlike a burst it is DETERMINISTIC for a wedged CLI — so exempting it from the caps turned
 * `maybeNameFromWork` into one continuously-running 60s child per agent forever, and left the
 * suggestions watcher re-issuing a doomed 180s compute on every tick. See {@link AiTransientError}.
 */
export class AiBusyError extends Error {
  constructor() {
    super("Claude is busy right now — try again in a moment");
    this.name = "AiBusyError";
  }
}

/**
 * A call that DID run and failed in a way worth retrying later — a wall-clock timeout, or the vendor
 * throttling us.
 *
 * Retryable, so it is not an {@link AiUnavailableError}: the identical call can succeed. But it is
 * BILLED, so unlike {@link AiBusyError} it must be CHARGED to the caller's attempt budget. That cap
 * is what stops a wedged CLI becoming an unbounded paid loop, which is precisely what these two
 * sentinels can produce if they are treated as free.
 *
 * It exists as a class (rather than a bare Error) so a modal renders a sentence rather than the raw
 * `ai_timeout` sentinel.
 */
export class AiTransientError extends Error {
  constructor(readonly sentinel: "ai_timeout" | "ai_rate_limited") {
    super(
      sentinel === "ai_timeout"
        ? "Claude took too long to answer — try again in a moment"
        : "Claude is rate-limiting requests — try again in a moment",
    );
    this.name = "AiTransientError";
  }
}

/**
 * Record what an AI call just proved about whether AI enhancement can run at all.
 *
 * **Every JS wrapper around an AI Tauri command owes BOTH PAIRS** — the provider pair here and the
 * service pair below. Today that is `anthropic_chat`, `generate_agent_name`, `judge_turn_followup`
 * and `summarize_attention`, plus anything added later. They all funnel through the same Rust
 * `claude_oneshot::run` and receive the same typed sentinels, but each owns a separate Tauri command
 * and a separate JS wrapper, so there is no single JS chokepoint to hook (roborev 54761). Wiring
 * only some of them was measured to break the detector: with `generate_agent_name` and
 * `judge_turn_followup` — the two highest-frequency callers in a multi-agent session — reporting to
 * the provider store only, a wedged CLI produced almost no service-health input at all.
 *
 * ONE ASYMMETRY, and it is deliberate. roborev 54761's warning — that a wrapper skipping this both
 * hides a live outage and, worse, leaves a false one on screen after recovery — applies in full to
 * the FAILURE half: every wrapper owes it, always.
 *
 * The SUCCESS half is different, and it is reported from a DIFFERENT PLACE. `judge`, `naming` and
 * `attention` all run `cacheable: true`, and `claude_oneshot` serves a cache hit BEFORE acquiring a
 * permit or spawning anything — so a hit proves nothing about the CLI's current state. Reporting
 * healthy from one would zero `consecutiveFailures`, the counter the `neutral` outcome exists to
 * protect, and a persistent unanswered prompt hits the cache on every tick, so a wedged CLI could
 * be masked indefinitely. Those three therefore still report FAILURES ONLY *from their wrappers*.
 *
 * Their RECOVERY now arrives out of band: Rust distinguishes a real spawn from a cache hit
 * (`claude_oneshot::OneShotReply.spawned`) and emits `ai://spawn-ok` only for the former, which
 * `services/aiServiceHealthListener.ts` turns into a single `noteAiServiceHealthy()`. So the cached
 * callers do clear a degraded banner — on evidence a hit cannot fake — without any wrapper here
 * having to decide. `chatOnce` keeps reporting its own success directly below, because it is
 * `cacheable: false` and every one of its replies is a real spawn by construction.
 *
 * That closes the gap this block used to describe: `chatOnce`'s only caller is the
 * learned-suggestions tier, which the user can switch off, and before the listener existed a user
 * in that configuration had nothing left that could retire the banner except
 * `aiServiceHealthStore.SERVICE_DEGRADED_MAX_AGE_MS` — a bound on a STALE claim, not a recovery
 * signal.
 */
export function noteAiProviderHealthy(): void {
  useAiProviderStore.getState().noteHealthy();
}

/** Counterpart to {@link noteAiProviderHealthy} — see its doc for why every wrapper needs both.
 *  Ignores anything that isn't a provider-outage sentinel, so it is safe to call on any rejection. */
export function noteAiProviderFailure(err: unknown): void {
  if (typeof err !== "string") return;
  const reason = parseUnavailableReason(err);
  if (reason) useAiProviderStore.getState().noteOutage(reason, Date.now());
}

/**
 * Record the SERVICE-level health of a call for the app-shell AiServiceBanner. Distinct from the
 * named-reason signal above: that one answers "what is wrong and what do I do about it", this one
 * answers "has this been failing for a while".
 *
 * Like the provider pair, and for the same reason (there is NO single JS chokepoint — roborev
 * 54761), EVERY wrapper must feed this. The one asymmetry is documented on the provider pair above:
 * a SUCCESS may only be reported by an UNCACHED caller, because claude_oneshot serves a cache hit
 * without spawning anything, so a hit proves nothing about the CLI's current state.
 */
export function noteAiServiceHealthy(): void {
  useAiServiceHealthStore.getState().noteSuccess();
}

/** Counterpart to {@link noteAiServiceHealthy}. Safe on any rejection: the store classifies the
 *  string and ignores anything that isn't a sustained-service signal, including the classes the
 *  named-reason banner owns. Non-string rejections carry no sentinel, so they are left untouched. */
export function noteAiServiceFailure(err: unknown): void {
  if (typeof err === "string") useAiServiceHealthStore.getState().noteFailure(err);
}

/** Map the Rust layer's typed sentinels onto a provider-outage reason.
 *
 *  Returns `undefined` when `err` is not an outage sentinel at all, so a caller can tell "not this
 *  error" from "this error". Rewritten with the transport: the reasons used to be Sparkle's vendor
 *  account (`provider_unfunded`, `provider_key_rejected`), which cannot occur now that there is no
 *  Sparkle-funded key. The failure modes that CAN occur are all local to the user's Claude Code
 *  install, and they are the ones worth naming on a banner because each has an action attached. */
export function parseUnavailableReason(err: string): AiProviderOutageReason | null | undefined {
  if (err === "ai_unconfigured") return "cli_missing";
  if (err === "claude_not_authenticated") return "cli_not_authenticated";
  if (err === "claude_usage_limit") return "usage_limit";
  return undefined;
}

/** The metering-only annotations attached to a proxied AI call — see {@link chatOnce}. Declared
 *  ABOVE chatOnce's doc block on purpose: sitting between the block and the function detached the
 *  whole comment onto this interface and left the documented chokepoint undocumented (roborev
 *  48157/48164). */
export interface Metering {
  /** Short human description of WHY this call was made. */
  purpose?: string;
  /** Display name of the project this call belongs to; omitted when unknown. */
  project?: string;
  /**
   * TRUE when the app fired this call itself (a timer, a settled state) rather than a human waiting
   * on it. Selects the Rust concurrency tier.
   *
   * Not cosmetic: automatic traffic left in the interactive tier competes for the small pool
   * reserved for blocked humans, and `suggestions/engine.ts` — which fires per agent on every
   * settled state — is this sink's highest-volume caller. Default false, so a caller that omits it
   * is treated as human-blocked (the safe direction).
   */
  background?: boolean;
}

/**
 * Send a single system+user turn to Claude and return the assistant's trimmed text. Runs on the
 * user's own Claude Code subscription (see the file header).
 *
 * Errors from the Rust side propagate as Error (a thrown string is wrapped with a friendly prefix).
 * The typed environmental sentinels become the {@link AiUnavailableError} family so callers DEFER
 * instead of spending a retry budget on a call that cannot succeed until something outside it
 * changes — and each one says what to fix.
 *
 * `metering` carries OPTIONAL diagnostic annotations (see {@link Metering}). It is an OBJECT rather
 * than trailing string params so a call site can't transpose them, and so a future annotation
 * doesn't churn every caller.
 *
 * NOTE: there is deliberately no local credit gate here any more — see the file header.
 */
export async function chatOnce(
  system: string,
  user: string,
  maxTokens = 1024,
  metering: Metering = {},
): Promise<string> {
  try {
    // Omit each annotation when unset so the invoke shape stays byte-identical for callers that
    // pass none (and the Rust `Option<String>` deserializes a missing key as None).
    const args: Record<string, unknown> = { system, user, maxTokens };
    if (metering.purpose !== undefined) args.purpose = metering.purpose;
    if (metering.project !== undefined) args.project = metering.project;
    if (metering.background !== undefined) args.background = metering.background;
    // Route off a walled default account to a healthy signed-in one when possible; only added when a
    // failover target exists, so the call shape is unchanged on the happy path. See
    // `accountSelection.oneshotFailoverConfigDir`.
    const configDir = await oneshotFailoverConfigDir();
    if (configDir) args.configDir = configDir;
    const raw = await invoke<string>("anthropic_chat", args);
    // A call that came back proves Sparkle's provider account is usable — clear any recorded outage
    // so the banner retires on its own the moment service is restored, with no restart or dismissal.
    noteAiProviderHealthy();
    // …and it proves the SERVICE is up, retiring the sustained-failure banner (aiServiceHealthStore).
    noteAiServiceHealthy();
    return raw.trim();
  } catch (err) {
    if (typeof err === "string") {
      // Record service-level health FIRST — record-only, changes no control flow below. The store
      // ignores anything another banner owns and only counts a SUSTAINED run toward the app-shell
      // AiServiceBanner, so a single blip never raises it.
      noteAiServiceFailure(err);
      // The `insufficient_credits` branch is GONE with the metered proxy: there is no Sparkle
      // balance on this route to exhaust, so the Rust side cannot produce that sentinel.
      //
      // Environmental and deferrable — and RECORDED, at the single chokepoint every call passes
      // through, so whichever feature fails first names the cause for all of them. That placement is
      // main's; only the reasons changed with the transport.
      const reason = parseUnavailableReason(err);
      if (reason !== undefined) {
        noteAiProviderFailure(err);
        if (reason === "cli_missing") throw new ClaudeMissingError();
        if (reason === "cli_not_authenticated") throw new ClaudeAuthError();
        throw new ClaudeUsageLimitError();
      }
      // Retryable, and none of them belongs to the NAMED-reason banner
      // (ProviderUnavailableBanner): that one exists to say what the user should fix, and none of
      // these has an answer to that. Their own class so callers can exempt them from bounded retry
      // budgets by type (see AiBusyError).
      //
      // They are NOT all equivalent to the SERVICE-health detector above, and the difference is
      // deliberate: `noteAiServiceFailure` counts a sustained run of `ai_timeout`/`ai_rate_limited`
      // toward the app-shell AiServiceBanner, while `ai_busy` is explicitly neutral there — it is
      // the concurrency cap declining to ask, which is evidence of neither health nor failure. See
      // classifyServiceFailure for why that neutrality is what lets the detector fire at all.
      // FREE (nothing spawned) vs BILLED (a child ran). Only the first may skip a retry budget.
      if (err === "ai_busy") throw new AiBusyError();
      if (err === "ai_timeout" || err === "ai_rate_limited") throw new AiTransientError(err);
      if (err === "ai_unreachable") {
        useConnectionStore.getState().applyProbe(false, Date.now());
        throw new AiUnreachableError();
      }
      throw new Error(`Claude request failed: ${err}`);
    }
    throw err;
  }
}

/**
 * Index of the delimiter that CLOSES the document opened at `start`, or -1 if the text runs out
 * first. Counts nesting depth and skips delimiters that live inside a JSON string (honoring
 * backslash escapes), so a bracket in a value — or in prose the model appended after the document —
 * can't be mistaken for the end of the document.
 */
function matchingClose(text: string, start: number): number {
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

/**
 * Extract a JSON document from a raw model reply: strip ```json/``` fences and any
 * surrounding prose, returning the outermost {...} or [...] substring (trimmed).
 * Falls back to the trimmed input if no object/array delimiters are found.
 *
 * The end delimiter is found by BALANCED, string-aware scanning from the opening one — not by
 * taking the last `]`/`}` in the reply. That shortcut silently corrupted otherwise-valid replies:
 * a model that closes its array and then adds a sentence containing a bracket ("...I ranked push
 * first [see the recent commits]") made the slice run past the document and into the prose, so a
 * usable answer was thrown away as a parse error and retried at full price. It also mangled
 * genuinely truncated replies — the slice ended at some earlier nested `]`, leaving an object open
 * and yielding a confusing "Expected '}'" instead of an honest unterminated-document error.
 */
export function extractJson(raw: string): string {
  let text = raw.trim();

  // Strip a leading fenced code block (```json ... ``` or ``` ... ```).
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1] !== undefined) text = fence[1].trim();

  // Locate the outermost object or array spanning the reply.
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  if (firstObj === -1 && firstArr === -1) return text;
  const start =
    firstArr === -1 || (firstObj !== -1 && firstObj < firstArr) ? firstObj : firstArr;

  const end = matchingClose(text, start);
  // Never closed: the reply was cut off mid-document. Nothing here can parse either way, so return
  // the document from its start — the leading prose is noise, and the caller's error is then about
  // the actual truncation rather than about a slice we chose badly.
  if (end === -1) return text.slice(start).trim();
  return text.slice(start, end + 1).trim();
}

/**
 * Ask Claude for a structured JSON answer and parse it into T. Appends a firm
 * JSON-only instruction to `system`, then robustly extracts and parses the reply.
 * Throws a clear Error (including the first ~200 chars of the raw reply) on parse failure.
 *
 * Shares chatOnce's transport, error taxonomy and optional diagnostic annotations (see
 * {@link chatOnce}) — including the absence of a local credit gate, since these calls spend the
 * user's own Claude subscription rather than Sparkle credits.
 */
export async function structuredJson<T>(
  system: string,
  user: string,
  maxTokens = 2048,
  metering: Metering = {},
): Promise<T> {
  const jsonSystem =
    `${system}\n\nRespond with ONLY valid, minified JSON and nothing else. ` +
    `Do not include any prose, explanations, or markdown code fences.`;
  const raw = await chatOnce(jsonSystem, user, maxTokens, metering);
  const candidate = extractJson(raw);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    throw new Error(`Claude did not return valid JSON: ${raw.slice(0, 200)}`);
  }
}
