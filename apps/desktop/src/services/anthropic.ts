// apps/desktop/src/services/anthropic.ts
// Frontend bindings for the Claude chat sink. The Rust command `anthropic_chat` no longer calls
// Anthropic directly with a BYOK key — it proxies through the orchestration `POST /ai/anthropic`
// route on the user's Sparkle bearer, where the server holds the vendor key and meters credits
// (Haiku 4.5 at 10× actual usage). Tauri maps the Rust `max_tokens` arg to JS `maxTokens`.
import { invoke } from "@tauri-apps/api/core";
import { OutOfCreditsError } from "./credits";
import { assertAiCredits } from "./aiGate";

/**
 * Send a single system+user turn to Claude and return the assistant's trimmed text.
 * Errors from the Rust side propagate as Error (a thrown string is wrapped with a friendly prefix).
 * The proxy's typed out-of-credits error (`insufficient_credits:<balanceCents>`) is re-thrown as an
 * {@link OutOfCreditsError} so callers surface the existing upsell/credits UI instead of a raw string.
 *
 * `purpose` is an OPTIONAL short (<=200 char) human-readable description of WHY this call was made
 * (e.g. "Renamed agent to 'Fix OAuth loop'"). It is metering-only — the server persists it into the
 * credit ledger row so the Credits history reads "AI: <purpose>"; it is NEVER sent to the vendor.
 *
 * The shared Anthropic chokepoint also enforces the hard credit gate: {@link assertAiCredits} throws
 * {@link OutOfCreditsError} up front when the balance is <= 0, so every call fails fast LOCALLY (no
 * server round-trip) when out of credits. Behavior is unchanged when the user has credits.
 */
export async function chatOnce(
  system: string,
  user: string,
  maxTokens = 1024,
  purpose?: string,
): Promise<string> {
  assertAiCredits();
  try {
    // Omit `purpose` when unset so the existing invoke shape is byte-identical for callers that
    // don't pass one (and the Rust `Option<String>` deserializes the missing key as None).
    const args: Record<string, unknown> = { system, user, maxTokens };
    if (purpose !== undefined) args.purpose = purpose;
    const raw = await invoke<string>("anthropic_chat", args);
    return raw.trim();
  } catch (err) {
    if (typeof err === "string") {
      // Typed server gate: `insufficient_credits:<balanceCents>` → the credits UX path.
      if (err.startsWith("insufficient_credits")) {
        const balanceCents = Number.parseInt(err.split(":")[1] ?? "", 10);
        throw new OutOfCreditsError(Number.isFinite(balanceCents) ? balanceCents : 0);
      }
      throw new Error(`Claude request failed: ${err}`);
    }
    throw err;
  }
}

/**
 * Extract a JSON document from a raw model reply: strip ```json/``` fences and any
 * surrounding prose, returning the outermost {...} or [...] substring (trimmed).
 * Falls back to the trimmed input if no object/array delimiters are found.
 */
export function extractJson(raw: string): string {
  let text = raw.trim();

  // Strip a leading fenced code block (```json ... ``` or ``` ... ```).
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1] !== undefined) text = fence[1].trim();

  // Locate the outermost object or array spanning the reply.
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  let start = -1;
  let open = "{";
  let close = "}";
  if (firstObj === -1 && firstArr === -1) return text;
  if (firstArr === -1 || (firstObj !== -1 && firstObj < firstArr)) {
    start = firstObj;
    open = "{";
    close = "}";
  } else {
    start = firstArr;
    open = "[";
    close = "]";
  }
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1).trim();
}

/**
 * Ask Claude for a structured JSON answer and parse it into T. Appends a firm
 * JSON-only instruction to `system`, then robustly extracts and parses the reply.
 * Throws a clear Error (including the first ~200 chars of the raw reply) on parse failure.
 *
 * Shares chatOnce's hard credit gate and optional metering-only `purpose` (see {@link chatOnce}).
 * `assertAiCredits` runs here too so the gate fires before the JSON-system prompt is even built.
 */
export async function structuredJson<T>(
  system: string,
  user: string,
  maxTokens = 2048,
  purpose?: string,
): Promise<T> {
  assertAiCredits();
  const jsonSystem =
    `${system}\n\nRespond with ONLY valid, minified JSON and nothing else. ` +
    `Do not include any prose, explanations, or markdown code fences.`;
  const raw = await chatOnce(jsonSystem, user, maxTokens, purpose);
  const candidate = extractJson(raw);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    throw new Error(`Claude did not return valid JSON: ${raw.slice(0, 200)}`);
  }
}
