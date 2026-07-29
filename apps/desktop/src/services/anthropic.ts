// apps/desktop/src/services/anthropic.ts
// Frontend bindings for the Claude chat sink. The Rust command `anthropic_chat` no longer calls
// Anthropic directly with a BYOK key — it proxies through the orchestration `POST /ai/anthropic`
// route on the user's Sparkle bearer, where the server holds the vendor key and meters credits
// (Haiku 4.5 at 10× actual usage). Tauri maps the Rust `max_tokens` arg to JS `maxTokens`.
import { invoke } from "@tauri-apps/api/core";
import { OutOfCreditsError } from "./credits";
import { assertAiCredits } from "./aiGate";
import { useConnectionStore } from "../stores/connectionStore";
import { useAuthStore } from "../stores/authStore";
import { useAiProviderStore, type AiProviderOutageReason } from "../stores/aiProviderStore";

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
 * The AI backend itself is unreachable/unserved — the proxy's typed `ai_unconfigured` sentinel,
 * which the Rust layer raises for a 503 (server has no vendor key) or a 404 (the `/ai/anthropic`
 * route isn't registered on the server we're pointed at). It is an ENVIRONMENTAL condition, not a
 * failure of the specific request: identical retries stay doomed until the backend comes back. So
 * it's modelled like being offline — callers should defer rather than spend a retry budget on it.
 *
 * `reason` names WHY when the proxy said so — `provider_unfunded` (Sparkle's provider account has no
 * credit) or `provider_key_rejected` (our key was refused). It is null for the reasonless shapes (an
 * unset server key, a missing route, an older server). Callers that merely need to defer should keep
 * branching on the TYPE; `reason` exists so the UI can name the cause instead of failing silently.
 */
export class AiUnavailableError extends Error {
  readonly reason: AiProviderOutageReason | null;
  constructor(reason: AiProviderOutageReason | null = null) {
    super(reason ? `AI backend is unavailable: ${reason}` : "AI backend is unavailable");
    this.name = "AiUnavailableError";
    this.reason = reason;
  }
}

/**
 * Record what a proxied AI call just proved about SPARKLE'S OWN provider account.
 *
 * **Every JS wrapper around a proxied Tauri command must call both of these** — `anthropic_chat`,
 * `generate_agent_name`, `judge_turn_followup`, `route_classify`, and anything added later. They all
 * funnel through the same Rust `call_anthropic_proxy` and so all receive the same
 * `ai_unconfigured:<reason>` sentinel, but each owns a separate Tauri command and a separate JS
 * wrapper, so there is no single JS chokepoint to hook (roborev 54761).
 *
 * Wiring only `chatOnce` was wrong in both directions:
 *   • a session whose AI activity is naming + concierge routing — both of which fail during exactly
 *     this outage — would get NO banner, which is the silence this whole change exists to end; and
 *   • worse, after the provider recovers, a successful naming/judge/route call would NOT clear a
 *     recorded outage. Since `useSuggestions` treats `AiUnavailableError` as terminal and burns the
 *     state's whole retry budget, `chatOnce` may not run again for a long stretch — leaving a
 *     non-dismissible banner telling the user the provider is out of credit while it is healthy.
 *     That is the same dishonesty this change removes, pointed the other way.
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

/** Parse the Rust layer's `ai_unconfigured[:<reason>]` sentinel into its optional reason.
 *  Returns `undefined` when `err` is not that sentinel at all, so the caller can tell "not this
 *  error" from "this error, no reason given". The reason is allow-listed on the Rust side, but it is
 *  re-checked here so this function is safe against any string and stays independently testable. */
export function parseUnavailableReason(err: string): AiProviderOutageReason | null | undefined {
  if (err === "ai_unconfigured") return null;
  if (!err.startsWith("ai_unconfigured:")) return undefined;
  const reason = err.slice("ai_unconfigured:".length);
  return reason === "provider_unfunded" || reason === "provider_key_rejected" ? reason : null;
}

/** The metering-only annotations attached to a proxied AI call — see {@link chatOnce}. Declared
 *  ABOVE chatOnce's doc block on purpose: sitting between the block and the function detached the
 *  whole comment onto this interface and left the documented chokepoint undocumented (roborev
 *  48157/48164). */
export interface Metering {
  /** Short human description of WHY this call was made. */
  purpose?: string;
  /** Display name of the project this spend belongs to; omitted when unknown. */
  project?: string;
}

/**
 * Send a single system+user turn to Claude and return the assistant's trimmed text.
 * Errors from the Rust side propagate as Error (a thrown string is wrapped with a friendly prefix).
 * The proxy's typed out-of-credits error (`insufficient_credits:<balanceCents>`) is re-thrown as an
 * {@link OutOfCreditsError} so callers surface the existing upsell/credits UI instead of a raw string;
 * its typed `ai_unconfigured` error becomes an {@link AiUnavailableError} so callers can defer.
 *
 * `metering` carries the OPTIONAL, metering-only annotations the Credits history renders. Neither
 * is ever sent to the vendor — the server persists them on the credit ledger row:
 *   • `purpose` — short (<=200 char) description of WHY this call was made (e.g. "Renamed agent to
 *     'Fix OAuth loop'"), shown as "AI: <purpose>".
 *   • `project` — display name (<=120 chars) of the project this spend belongs to, so the history
 *     can answer "which project did this cost me?". Omit it when the caller genuinely doesn't know;
 *     the row then shows no project rather than a guess (see services/creditProject.ts).
 *
 * It is an OBJECT rather than two trailing string params so a call site can't transpose them, and
 * so a future annotation doesn't churn every caller.
 *
 * The shared Anthropic chokepoint also enforces the hard credit gate: {@link assertAiCredits} throws
 * {@link OutOfCreditsError} up front when the balance is <= 0, so every call fails fast LOCALLY (no
 * server round-trip) when out of credits. Behavior is unchanged when the user has credits.
 */
export async function chatOnce(
  system: string,
  user: string,
  maxTokens = 1024,
  metering: Metering = {},
): Promise<string> {
  assertAiCredits();
  try {
    // Omit each annotation when unset so the invoke shape stays byte-identical for callers that
    // pass none (and the Rust `Option<String>` deserializes a missing key as None).
    const args: Record<string, unknown> = { system, user, maxTokens };
    if (metering.purpose !== undefined) args.purpose = metering.purpose;
    if (metering.project !== undefined) args.project = metering.project;
    const raw = await invoke<string>("anthropic_chat", args);
    // A call that came back proves Sparkle's provider account is usable — clear any recorded outage
    // so the banner retires on its own the moment service is restored, with no restart or dismissal.
    noteAiProviderHealthy();
    return raw.trim();
  } catch (err) {
    if (typeof err === "string") {
      // Typed server gate: `insufficient_credits:<balanceCents>` → the credits UX path.
      if (err.startsWith("insufficient_credits")) {
        const parsed = Number.parseInt(err.split(":")[1] ?? "", 10);
        // null = no amount reported; the contract and its dormancy live on the
        // `AuthStore.noteCreditsRefused` doc in authStore.ts.
        const reported = Number.isFinite(parsed) ? parsed : null;
        // Read BEFORE the store call — the mutation must not be able to change what we report.
        // Mirrors the store's own null-branch derivation; keep the two in step.
        const held = useAuthStore.getState().me?.balanceCents ?? 0;
        // Record the server's refusal so `hasAiCredits` closes NOW. Without this it was discarded,
        // and a leftover balance kept passing `balance > 0` — every AI surface re-issuing the same
        // guaranteed-402 request indefinitely.
        useAuthStore.getState().noteCreditsRefused(reported);
        // Prefer the held balance over a fabricated 0 on `OutOfCreditsError.balanceCents`, which
        // nothing renders today — see its doc. Contract-hardening, not a live display fix.
        throw new OutOfCreditsError(reported ?? held);
      }
      // Typed server gate: `ai_unconfigured[:<reason>]` → the backend is down/unserved, deferrable.
      // When the proxy named a reason, RECORD it: that observation is the only thing standing
      // between "every AI feature is quietly dead" and a banner that says why. Recorded here, at the
      // single chokepoint every proxied call passes through, so whichever feature fails first lights
      // the banner for all of them — the same placement as `noteCreditsRefused` above.
      const reason = parseUnavailableReason(err);
      if (reason !== undefined) {
        noteAiProviderFailure(err);
        throw new AiUnavailableError(reason);
      }
      // A transport failure is FRESHER evidence of connectivity than the 30s reachability
      // heartbeat: we just proved the host is unreachable with a real request. Feed that straight
      // into the store (the heartbeat's own next tick re-confirms, and flips us back on recovery)
      // so the offline banner is accurate and every AI caller can take its defer path immediately
      // instead of retrying against a stale `isOnline === true`.
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
 * Shares chatOnce's hard credit gate and optional metering-only annotations (see {@link chatOnce}).
 * `assertAiCredits` runs here too so the gate fires before the JSON-system prompt is even built.
 */
export async function structuredJson<T>(
  system: string,
  user: string,
  maxTokens = 2048,
  metering: Metering = {},
): Promise<T> {
  assertAiCredits();
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
