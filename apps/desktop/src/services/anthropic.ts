// apps/desktop/src/services/anthropic.ts
// Frontend bindings for the Claude-direct chat sink (Rust: src-tauri command `anthropic_chat`,
// model claude-sonnet-4-6). Tauri maps the Rust `max_tokens` arg to JS `maxTokens` (camelCase).
import { invoke } from "@tauri-apps/api/core";

/**
 * Send a single system+user turn to Claude and return the assistant's trimmed text.
 * Errors from the Rust side propagate as Error (a thrown string is wrapped with a friendly prefix).
 */
export async function chatOnce(system: string, user: string, maxTokens = 1024): Promise<string> {
  try {
    const raw = await invoke<string>("anthropic_chat", { system, user, maxTokens });
    return raw.trim();
  } catch (err) {
    if (typeof err === "string") throw new Error(`Claude request failed: ${err}`);
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
 */
export async function structuredJson<T>(system: string, user: string, maxTokens = 2048): Promise<T> {
  const jsonSystem =
    `${system}\n\nRespond with ONLY valid, minified JSON and nothing else. ` +
    `Do not include any prose, explanations, or markdown code fences.`;
  const raw = await chatOnce(jsonSystem, user, maxTokens);
  const candidate = extractJson(raw);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    throw new Error(`Claude did not return valid JSON: ${raw.slice(0, 200)}`);
  }
}
