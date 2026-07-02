// The per-agent Claude model list (bead sparkle-i6rw).
//
// Phase 1 shipped a CURATED static list (CLAUDE_MODELS). Phase 2 makes the catalog DYNAMIC: on
// app start (and lazily when a ModelPill dropdown opens) we invoke the `list_claude_models` Tauri
// command, which lists the models the user's own (BYOK) Anthropic key can see via GET /v1/models.
// That dynamic list becomes the live catalog; the curated list is the always-present fallback when
// there is no key, the network is down, or the fetch returns nothing.
//
// The curated exports (CLAUDE_MODELS, DEFAULT_MODEL_ID, isDefaultModel, modelShortLabel) stay so
// every Phase 1 call site and test keeps working. `modelShortLabel` now consults the LIVE catalog
// first (so a dynamic-only id gets a real short label) before falling back to the curated list and
// finally the raw id.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ClaudeModelOption {
  /** The `--model` / `/model` id Claude Code accepts, or the DEFAULT_MODEL_ID sentinel. */
  id: string;
  /** Full label for the dropdown menu. */
  label: string;
  /** Short label for the pill on the agent card. */
  short: string;
}

/** Sentinel meaning "no --model flag — inherit the user's own Claude Code default". Persisted
 *  agents may also carry `model: undefined`, which means the same thing. */
export const DEFAULT_MODEL_ID = "default";

/** The curated fallback list. First entry is the Default sentinel, then the models we ship
 *  short/long labels for. This is what renders before (or instead of) a dynamic fetch. */
export const CLAUDE_MODELS: ClaudeModelOption[] = [
  { id: DEFAULT_MODEL_ID, label: "Default (Claude Code setting)", short: "Default" },
  { id: "claude-fable-5", label: "Fable 5", short: "Fable" },
  { id: "claude-opus-4-8", label: "Opus 4.8", short: "Opus" },
  { id: "claude-sonnet-5", label: "Sonnet 5", short: "Sonnet" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", short: "Haiku" },
];

/** The Default sentinel option, always the head of any catalog (curated or merged). */
const DEFAULT_OPTION = CLAUDE_MODELS[0]!;

/** Is this model value (id or undefined) the "inherit Claude Code's default" sentinel? */
export function isDefaultModel(id: string | undefined): boolean {
  return !id || id === DEFAULT_MODEL_ID;
}

// ---------------------------------------------------------------------------------------------
// Dynamic catalog: module-singleton state + a minimal external store so subscribers (ModelPill)
// re-render when the catalog updates.
// ---------------------------------------------------------------------------------------------

/** The wire shape the Rust `list_claude_models` command returns (snake_case, mirrors Anthropic). */
interface DynamicModel {
  id: string;
  display_name: string;
}

const LS_KEY = "sparkle.modelCatalog.v1";
/** Don't re-hit the network more than once per this window when a dropdown is opened repeatedly. */
const REFRESH_TTL_MS = 5 * 60_000;

/** The live catalog. Starts as the curated list and is replaced when a dynamic fetch succeeds.
 *  Held by reference so `useSyncExternalStore` sees a stable snapshot until it actually changes. */
let catalog: ClaudeModelOption[] = CLAUDE_MODELS;
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let lastRefreshMs = 0;

/** Current live catalog (curated fallback until a dynamic fetch replaces it). */
export function getModelCatalog(): ClaudeModelOption[] {
  return catalog;
}

/** Subscribe to catalog changes; returns an unsubscribe fn. Backs `useModelCatalog`. */
export function subscribeModelCatalog(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook: the live catalog, re-rendering the component when it updates. */
export function useModelCatalog(): ClaudeModelOption[] {
  return useSyncExternalStore(subscribeModelCatalog, getModelCatalog, getModelCatalog);
}

function setCatalog(next: ClaudeModelOption[]): void {
  catalog = next;
  for (const cb of listeners) cb();
}

/** The pill display label for a model id. Consults the LIVE catalog first (so a dynamic-only id
 *  gets a real short label), then the curated list, then the raw id — so the pill never goes blank
 *  and always says something truthful (an unknown/legacy persisted id shows as itself). */
export function modelShortLabel(id: string | undefined): string {
  // Inline default check (not isDefaultModel) so TypeScript narrows `id` to string below.
  if (!id || id === DEFAULT_MODEL_ID) return "Default";
  return (
    catalog.find((m) => m.id === id)?.short ??
    CLAUDE_MODELS.find((m) => m.id === id)?.short ??
    id
  );
}

/** Derive a short pill label from a display name for an id not in the curated list. Strips a
 *  leading "Claude " and takes the first word — "Claude Opus 4.8" → "Opus", "Claude Haiku 4.5" →
 *  "Haiku" — matching the curated shorts. Falls back to the whole display name, then the id. */
function deriveShort(displayName: string, id: string): string {
  const stripped = displayName.replace(/^claude\s+/i, "").trim();
  const first = stripped.split(/\s+/)[0];
  return first || displayName.trim() || id;
}

/** Merge a dynamic model list into a catalog: the dynamic list BECOMES the catalog, but the
 *  Default sentinel is always first, curated short/long labels are preserved for known ids, and
 *  unknown ids get a short derived from their display_name. Deduped by id. An empty/absent dynamic
 *  list (or one that contributes no usable models) leaves the curated list unchanged — returning
 *  the exact CLAUDE_MODELS reference so callers can detect "no change" by identity. */
export function mergeCatalog(dynamic: readonly DynamicModel[] | null | undefined): ClaudeModelOption[] {
  if (!dynamic || dynamic.length === 0) return CLAUDE_MODELS;
  const curatedById = new Map(CLAUDE_MODELS.map((m) => [m.id, m] as const));
  const seen = new Set<string>([DEFAULT_OPTION.id]);
  const merged: ClaudeModelOption[] = [DEFAULT_OPTION];
  for (const dm of dynamic) {
    const id = dm?.id?.trim();
    if (!id || id === DEFAULT_MODEL_ID || seen.has(id)) continue;
    seen.add(id);
    const curated = curatedById.get(id);
    if (curated) {
      merged.push(curated);
    } else {
      const display = (dm.display_name ?? "").trim() || id;
      merged.push({ id, label: display, short: deriveShort(display, id) });
    }
  }
  // Only the sentinel survived (every entry was filtered) → keep the curated list.
  return merged.length > 1 ? merged : CLAUDE_MODELS;
}

function persist(next: ClaudeModelOption[]): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    // localStorage can throw (private mode, quota); a cache miss is harmless.
  }
}

/** Seed the catalog from the last persisted merged list so the pill renders the dynamic list
 *  instantly on the next launch, before the fresh fetch returns. Corrupt/partial caches are
 *  ignored. Must lead with the Default sentinel or we discard it (defensive against tampering). */
function seedFromCache(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const opts = parsed.filter(
      (m): m is ClaudeModelOption =>
        !!m &&
        typeof m.id === "string" &&
        typeof m.label === "string" &&
        typeof m.short === "string",
    );
    if (opts.length > 1 && opts[0]!.id === DEFAULT_MODEL_ID) {
      catalog = opts;
    }
  } catch {
    // Ignore a corrupt cache — the curated list is a fine starting point.
  }
}

seedFromCache();

/** Refresh the catalog from the user's BYOK key via the `list_claude_models` Tauri command. Merges
 *  the dynamic list over the curated fallback and notifies subscribers. Silently keeps the current
 *  catalog on any failure (no Tauri host, no key, network error — the command resolves to an empty
 *  list, which merges to "no change"). Deduped: concurrent calls share one in-flight request, and a
 *  successful refresh within the last {@link REFRESH_TTL_MS} is skipped unless `force` is set. */
export async function refreshModelCatalog(opts?: { force?: boolean }): Promise<void> {
  if (inFlight) return inFlight;
  if (!opts?.force && lastRefreshMs !== 0 && Date.now() - lastRefreshMs < REFRESH_TTL_MS) return;
  inFlight = (async () => {
    try {
      const dynamic = await invoke<DynamicModel[]>("list_claude_models");
      const merged = mergeCatalog(Array.isArray(dynamic) ? dynamic : []);
      if (merged !== CLAUDE_MODELS) {
        setCatalog(merged);
        persist(merged);
      }
    } catch {
      // invoke rejected (no host, command/join error) — leave the catalog as-is.
    } finally {
      // Arm the TTL on EVERY outcome, including failure — otherwise a persistent failure (no Tauri
      // host in a dev browser, a down endpoint) would re-fire on every dropdown open with no
      // throttle. A `force` refresh (or the next launch) still bypasses this.
      lastRefreshMs = Date.now();
      inFlight = null;
    }
  })();
  return inFlight;
}
