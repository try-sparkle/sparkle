// epicPrd — an epic's PRD path as a STRUCTURED FIELD, with the prose back-link as fallback only.
//
// The frontend half of `src-tauri/src/epic_prd.rs` (bead `sparkle-xelans.5`). Read that file's
// header first: it states why the PRD path lives in bd METADATA rather than in the desktop's
// persisted store the way `engine/epicGoal.ts` keeps an epic's GOAL, and that decision is not
// relitigated here. The short version is that the intended reader is a FUTURE AGENT running
// `bd show <epic>` in some other worktree, and a path in this app's local store is invisible to
// every one of them.
//
// ── WHY THE RESOLVE RULE IS A FUNCTION IN THIS FILE AND NOT FOUR COPIES ──────────────────────
// Four surfaces ask "where is this epic's PRD?" — the epic ladder's drag-to-stage, the Build It
// hook, the stall sweep's restart, and `decomposeEpic`. Before this file each one wrote
// `parsePrdRef(bead.description)?.relPath ?? null` inline. That is exactly the multiple-ways
// problem the parent bead `sparkle-xelans` is about: when one copy is later widened, git merges
// the other three cleanly and nothing reports that they now disagree. {@link resolveEpicPrdPath}
// is the ONE rule; the four call sites pass it a bead and an index and read the answer.
//
// ── PROSE IS KEPT, DELIBERATELY ─────────────────────────────────────────────────────────────
// {@link parsePrdRef} is not deprecated and is not going away. Thousands of existing epics carry
// their PRD only as a `PRD file:` line in the body, written by `generateTasks` long before any
// metadata key existed, and for those the prose IS the record. Structured-first, prose-fallback
// is what lets the new field arrive without retiring anything.
import { useEffect, useState } from "react";

import { invoke } from "./ipc";
import { log } from "../logger";

/**
 * THE metadata key, mirroring `EPIC_PRD_KEY` in `src-tauri/src/epic_prd.rs`. A second spelling on
 * either side would write a key nothing reads, silently — the failure the bead exists to end.
 */
export const EPIC_PRD_METADATA_KEY = "prd";

/**
 * One epic's structured PRD back-link, as `list_epic_prd` reports it.
 *
 * ── THE WIRE SHAPE IS EXACTLY THE RUST STRUCT, AND BOTH FIELDS ARE REQUIRED ────────────────
 * `EpicPrdEntry` in `epic_prd.rs` is `{ id: String, prd: String }` — no `Option` on either field,
 * so neither can ever arrive as `null`. Had one been an `Option<T>`, serde would emit the key with
 * a `null` VALUE rather than omitting it (only `skip_serializing_if` omits), so the TypeScript
 * would have to read `field?: T | null`: plain `field?: T` means `T | undefined`, which EXCLUDES
 * null, and describes a shape the wire cannot produce. That is written down here because the next
 * field added to the Rust struct is where it will matter, and {@link normalizeEntries} below is
 * tolerant precisely so a mismatch degrades one row instead of the whole read.
 */
export interface EpicPrdEntry {
  id: string;
  /** The repo-relative PRD path, exactly as it was written (paths may contain spaces). */
  prd: string;
}

/** id → repo-relative PRD path, for every bead carrying the `prd` metadata key. */
export type EpicPrdIndex = ReadonlyMap<string, string>;

/** One frozen empty index, so "no data" does not mint a new identity on every render. */
export const EMPTY_EPIC_PRD_INDEX: EpicPrdIndex = new Map<string, string>();

/** The minimum a reader needs: an id to look up and a body to fall back to. Structural, so every
 *  call site can pass its own `Bead` without this module importing the board's types. */
export interface EpicPrdBead {
  id: string;
  description?: string | null;
}

// ── The rule ──────────────────────────────────────────────────────────────────────────────────

/** Pull the `PRD file: <relPath>` back-link out of an epic body (written by `generateTasks`).
 *  Returns the repo-relative path plus the bare filename (what the read_prd / write_prd commands
 *  take), or null when the body carries no PRD reference. Pure.
 *
 *  Lives here rather than in `tasks.ts` (which re-exports it, so every existing importer and its
 *  tests are unchanged) so that the resolve rule below can call it without `tasks.ts` and this
 *  module importing each other. */
export function parsePrdRef(body: string): { relPath: string; filename: string } | null {
  // Capture to end of line, not \S+ — PRD paths may contain spaces (write_prd allows them).
  const relPath = /PRD file:[ \t]*(.+)$/m.exec(body)?.[1]?.trim();
  if (!relPath) return null;
  const filename = relPath.split("/").pop();
  if (!filename) return null;
  return { relPath, filename };
}

/**
 * THE resolve rule, in ONE place: structured `prd` metadata first, the prose `PRD file:` line only
 * when there is no metadata.
 *
 * The order is the whole point and is the one thing a test must pin. An epic that has BOTH — a
 * recorded metadata path and an older, different `PRD file:` line still sitting in its body —
 * resolves the METADATA path. Asserting only that the two agree when they say the same thing
 * cannot tell this rule apart from the one it replaced.
 *
 * Absent, blank or whitespace-only metadata is treated as ABSENT, not as "this epic has no PRD":
 * a key that lost its value must degrade to the prose the epic has always carried, never retire it.
 */
export function resolveEpicPrdPath(
  bead: EpicPrdBead | null | undefined,
  index?: EpicPrdIndex | null,
): string | null {
  return resolveEpicPrdRef(bead, index)?.relPath ?? null;
}

/**
 * {@link resolveEpicPrdPath}, but returning the bare filename alongside the repo-relative path —
 * `read_prd` / `write_prd` take the filename, so `decomposeEpic` needs both halves. Same rule,
 * same order; this is the function that implements it and the path-only form delegates here.
 */
export function resolveEpicPrdRef(
  bead: EpicPrdBead | null | undefined,
  index?: EpicPrdIndex | null,
): { relPath: string; filename: string } | null {
  if (!bead) return null;
  const structured = index?.get(bead.id)?.trim();
  if (structured) {
    const filename = structured.split("/").pop();
    if (filename) return { relPath: structured, filename };
  }
  return parsePrdRef(bead.description ?? "");
}

// ── The commands ──────────────────────────────────────────────────────────────────────────────

/**
 * Record an epic's PRD path as structured `prd` metadata on the bead. Idempotent — bd overwrites
 * the key, so re-recording the same path is a no-op write rather than a second value.
 */
export async function setEpicPrd(
  projectPath: string,
  id: string,
  prdPath: string,
): Promise<void> {
  await invoke<void>("set_epic_prd", { projectPath, id, prdPath });
}

/** Every bead in this project that carries a `prd` metadata key, as `{id, prd}` pairs. */
export async function listEpicPrd(projectPath: string): Promise<EpicPrdEntry[]> {
  return normalizeEntries(await invoke<unknown>("list_epic_prd", { projectPath }));
}

/**
 * Read the command's answer TOLERANTLY — a row missing an id, or whose `prd` is not a non-empty
 * string, is skipped rather than failing the whole read. The Rust parser is tolerant in exactly
 * this shape and for exactly this reason: an all-or-nothing parse that rejects one row would
 * discard every OTHER epic's PRD link and fall back to "we did not look", permanently and
 * silently, which is how a shipped feature never once runs.
 */
function normalizeEntries(raw: unknown): EpicPrdEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: EpicPrdEntry[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const { id, prd } = row as { id?: unknown; prd?: unknown };
    if (typeof id !== "string" || !id) continue;
    if (typeof prd !== "string" || !prd.trim()) continue;
    out.push({ id, prd: prd.trim() });
  }
  return out;
}

/** Build the id → path index from a command result. Pure. */
export function epicPrdIndexFrom(entries: readonly EpicPrdEntry[]): EpicPrdIndex {
  return new Map(entries.map((e) => [e.id, e.prd]));
}

// ── The cached index ──────────────────────────────────────────────────────────────────────────
//
// `list_epic_prd` shells out to bd. Measured against this repo it answers in ~3.6s, which is fine
// once and ruinous per render — `useBeadBuildActions` runs on EVERY mounted bead card. So the
// index is cached per project path with an in-flight dedupe, and a stale-but-present index is
// preferred over a blocking re-read: the fallback for a miss is the prose the epic already
// carries, so the worst a stale index can do is resolve the older of two answers.

const CACHE = new Map<string, { index: EpicPrdIndex; at: number }>();
const INFLIGHT = new Map<string, Promise<EpicPrdIndex>>();
const SUBSCRIBERS = new Set<() => void>();

/** How long a loaded index is served without a re-read. */
export const EPIC_PRD_INDEX_TTL_MS = 60_000;

/** The already-loaded index for this project, or the empty one. Synchronous, for render paths. */
export function epicPrdIndexSnapshot(projectPath: string | null | undefined): EpicPrdIndex {
  if (!projectPath) return EMPTY_EPIC_PRD_INDEX;
  return CACHE.get(projectPath)?.index ?? EMPTY_EPIC_PRD_INDEX;
}

/**
 * Load (or serve from cache) this project's PRD index.
 *
 * NEVER THROWS. A bd read that fails resolves to the empty index, which sends every reader to the
 * prose fallback — the behaviour the app had before this field existed. A structured PRD path is
 * an improvement on a back-link, not a dependency of one, so nothing here may turn a failed read
 * into a failed decompose or a failed drop.
 */
export async function loadEpicPrdIndex(
  projectPath: string | null | undefined,
  opts: { now?: number; force?: boolean } = {},
): Promise<EpicPrdIndex> {
  if (!projectPath) return EMPTY_EPIC_PRD_INDEX;
  const now = opts.now ?? Date.now();
  const hit = CACHE.get(projectPath);
  if (!opts.force && hit && now - hit.at < EPIC_PRD_INDEX_TTL_MS) return hit.index;

  const pending = INFLIGHT.get(projectPath);
  if (pending) return pending;

  const run = listEpicPrd(projectPath)
    .then((entries) => {
      const index = epicPrdIndexFrom(entries);
      CACHE.set(projectPath, { index, at: Date.now() });
      for (const notify of SUBSCRIBERS) notify();
      return index;
    })
    .catch((e: unknown) => {
      log.warn("epics", "could not read structured PRD metadata; falling back to the prose link", {
        projectPath,
        error: String(e),
      });
      // Deliberately NOT cached: a transient bd lock must not pin every reader to the fallback
      // for a whole TTL window.
      return hit?.index ?? EMPTY_EPIC_PRD_INDEX;
    })
    .finally(() => {
      INFLIGHT.delete(projectPath);
    });
  INFLIGHT.set(projectPath, run);
  return run;
}

/** Drop every cached index. Tests only — production has no reason to forget. */
export function resetEpicPrdIndexCache(): void {
  CACHE.clear();
  INFLIGHT.clear();
}

/**
 * The cached index for a project, kept fresh for a React tree.
 *
 * Returns the snapshot synchronously (empty on the first render) and re-renders once the load
 * lands. Safe to call from a hook that runs per card: the load is deduped and cached, so N mounted
 * cards make at most one bd call per TTL window.
 */
export function useEpicPrdIndex(projectPath: string | null | undefined): EpicPrdIndex {
  const [index, setIndex] = useState<EpicPrdIndex>(() => epicPrdIndexSnapshot(projectPath));

  useEffect(() => {
    let live = true;
    const sync = () => {
      if (live) setIndex(epicPrdIndexSnapshot(projectPath));
    };
    SUBSCRIBERS.add(sync);
    sync();
    void loadEpicPrdIndex(projectPath).then(sync);
    return () => {
      live = false;
      SUBSCRIBERS.delete(sync);
    };
  }, [projectPath]);

  return index;
}
