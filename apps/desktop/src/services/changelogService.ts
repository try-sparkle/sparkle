// changelogService — the data behind the in-app "What's New" panel (components/WhatsNewPanel).
//
// WHY THIS EXISTS. The app's only changelog affordance used to hand the user to
// https://sparkle.ai/changelog in the system browser. That page was frozen 35 releases behind, so a
// founder who restarted onto a new build and asked "what's different?" got no answer without
// leaving the app. This module fetches the curated rows the website reads and lets the app answer
// in place.
//
// TWO RULES THAT ARE NOT NEGOTIABLE, both of which have already cost this repo a shipped bug:
//
//  1. NEVER fetch GitHub at runtime. The repo is private, so a runtime GitHub call fails outright —
//     that is the exact wall this whole feature exists to route around. The ONE source is
//     `https://sparkle.ai/api/changelog/entries`, which is public and needs no auth.
//  2. PARSE DEFENSIVELY, PER ENTRY. `releaseVersion` is a Rust `Option` on the wire, and serde's
//     derive emits `"releaseVersion": null` rather than omitting the key. A parser written against
//     `releaseVersion?: string` describes a shape the wire cannot produce, and an all-or-nothing
//     parser that rejects the payload over it renders an EMPTY panel forever with nothing logged.
//     So the type says `string | null`, and one bad row is dropped rather than the whole response.
//
// Offline behaviour is FAIL-OPEN, never an error wall: the last good response is cached in
// localStorage and shown with a quiet "may be out of date" note. A slightly stale What's New beats
// a panel that says nothing.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { log } from "../logger";

const SCOPE = "changelog";

/** The FROZEN data contract (see PRD/sparkle/changelog-pipeline-recovery.md). Public, no auth. */
export const CHANGELOG_API_URL = "https://sparkle.ai/api/changelog/entries";

/** localStorage key holding the last successful fetch, so an offline launch still has content. */
export const CHANGELOG_CACHE_KEY = "sparkle-changelog-cache";

/** How long a network fetch may hang before we fall back to the cache. */
const FETCH_TIMEOUT_MS = 8000;

/** The three change types the pipeline emits. Anything else is normalised to "enhancement". */
export type ChangeType = "feature" | "enhancement" | "bug_fix";

/** One curated changelog row — mirrors `ChangelogEntryView` in apps/web/src/lib/changelog.ts. */
export interface ChangelogEntry {
  id: string;
  slug: string;
  /** ISO timestamp. Kept as the raw string; formatted at render time. */
  shippedAt: string;
  title: string;
  summary: string;
  bullets: string[];
  changeType: ChangeType;
  categories: string[];
  links: { label: string; href: string }[];
  surfaces: string[];
  /**
   * The release this entry shipped in, or null when it is curated but not yet stamped to one.
   *
   * `string | null`, NOT `string | undefined`. See rule 2 in the header — the wire sends an
   * explicit null and a type that cannot express that is how this feature ships inert.
   */
  releaseVersion: string | null;
}

/** What the panel renders from: the rows plus how much to trust them. */
export interface ChangelogSnapshot {
  entries: ChangelogEntry[];
  /** We are showing a CACHED response because the live fetch failed — show the "may be out of
   *  date" note. */
  stale: boolean;
  /** The server answered, but told us it could not reach its own database — same note, different
   *  cause. Tolerated as an extra field on the payload rather than required. */
  degraded: boolean;
  /** Epoch ms the shown rows were fetched, or null when we have never had a successful fetch. */
  fetchedAt: number | null;
}

// --- Semantic version comparison -------------------------------------------------------------
// "v0.102.0" is NEWER than "v0.99.0". A string sort gets that backwards, which is precisely the
// comparison every part of this feature turns on (what to highlight, whether to auto-open).

/**
 * The leading numeric segments of a version, `v`-prefix tolerated, stopping at the first segment
 * that isn't all digits (so a `-beta.1` suffix doesn't shift `1` into the patch slot).
 */
function versionParts(version: string | null | undefined): number[] {
  const out: number[] = [];
  const cleaned = String(version ?? "")
    .trim()
    .replace(/^[vV]/, "");
  if (!cleaned) return out;
  for (const seg of cleaned.split(/[.\-+]/)) {
    if (!/^\d+$/.test(seg)) break;
    out.push(Number.parseInt(seg, 10));
  }
  return out;
}

/** -1 / 0 / 1, comparing versions SEMANTICALLY. Missing segments count as 0 (1.2 === 1.2.0). */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Is `a` a strictly newer release than `b`? */
export function isNewerVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  return compareVersions(a, b) > 0;
}

/** Display form: always `v`-prefixed, whichever form the wire used. */
export function displayVersion(version: string | null | undefined): string {
  const v = String(version ?? "").trim();
  if (!v) return "Unreleased";
  return v.startsWith("v") || v.startsWith("V") ? v : `v${v}`;
}

// --- Parsing ----------------------------------------------------------------------------------

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(asString).filter(Boolean);
}

function asLinks(v: unknown): { label: string; href: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { label: string; href: string }[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const href = asString(o.href);
    if (!href) continue;
    out.push({ label: asString(o.label) || href, href });
  }
  return out;
}

function asChangeType(v: unknown): ChangeType {
  const s = asString(v);
  return s === "feature" || s === "bug_fix" || s === "enhancement" ? s : "enhancement";
}

/**
 * One row, or null when it is too broken to render.
 *
 * The bar for "too broken" is deliberately LOW — an id and a title. Everything else degrades to an
 * empty value, because dropping a row costs the user that row while rejecting the payload costs
 * them the whole panel.
 */
export function parseChangelogEntry(raw: unknown): ChangelogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = asString(o.title);
  const slug = asString(o.slug);
  const id = asString(o.id) || slug;
  if (!id || !title) return null;
  return {
    id,
    slug: slug || id,
    shippedAt: asString(o.shippedAt),
    title,
    summary: asString(o.summary),
    bullets: asStringArray(o.bullets),
    changeType: asChangeType(o.changeType),
    categories: asStringArray(o.categories),
    links: asLinks(o.links),
    surfaces: asStringArray(o.surfaces),
    // `null` and an absent key mean the same thing here, and BOTH must survive to render.
    releaseVersion: asString(o.releaseVersion) || null,
  };
}

/**
 * The endpoint's ACTUAL degradation signal, confirmed by reading the shipped route rather than
 * guessed: `/api/changelog/entries` answers `{ ok: true, source: "database" | "unavailable" }`,
 * where "unavailable" means it could not reach the store — so `entries: []` means "could not
 * look", not "nothing new". It is a string VALUE, not a flag key.
 *
 * That distinction is the whole bug this constant exists to close. DEGRADED_KEYS below probes for
 * truthy KEYS, and the payload carries no key named `unavailable` — it carries `source` whose
 * value happens to be that word. So the key probe alone could never fire against the real server,
 * and the panel would have reported a confident "nothing new" every time the database was
 * unreachable, silently never using the cache it keeps for exactly that case.
 */
function hasDegradedSourceValue(o: Record<string, unknown>): boolean {
  if (o.ok === false) return true;
  const source = typeof o.source === "string" ? o.source.toLowerCase() : "";
  return source === "unavailable" || source === "degraded" || source === "cache";
}

/** Keys a server might use to say "I answered, but from a degraded path". Any truthy one counts. */
const DEGRADED_KEYS = [
  "degraded",
  "stale",
  "databaseUnavailable",
  "dbUnavailable",
  "unavailable",
  "unreachable",
  "fallback",
  "error",
];

/**
 * Narrow a whole response body.
 *
 * Accepts a BARE ARRAY or an object wrapping the rows, because the endpoint is being built
 * concurrently by another worker and there is no channel to agree on one shape. Unknown wrapper
 * fields are ignored, except that a truthy degradation flag is surfaced.
 */
export function parseChangelogPayload(raw: unknown): { entries: ChangelogEntry[]; degraded: boolean } {
  let rows: unknown[] = [];
  let degraded = false;
  if (Array.isArray(raw)) {
    rows = raw;
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const key of ["entries", "items", "data", "results"]) {
      if (Array.isArray(o[key])) {
        rows = o[key] as unknown[];
        break;
      }
    }
    // BOTH probes: the value-shaped signal the real endpoint sends, and the truthy-key probe kept
    // as tolerance for a future shape change. Either one alone is insufficient — see
    // hasDegradedSourceValue for why the key probe could never fire on today's payload.
    degraded = hasDegradedSourceValue(o) || DEGRADED_KEYS.some((k) => Boolean(o[k]));
  }
  const entries: ChangelogEntry[] = [];
  for (const row of rows) {
    const parsed = parseChangelogEntry(row);
    if (parsed) entries.push(parsed);
  }
  return { entries, degraded };
}

// --- Ordering + partitioning ------------------------------------------------------------------

function shippedAtMs(entry: ChangelogEntry): number {
  const t = Date.parse(entry.shippedAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Newest first, as a TOTAL order (so the sort is deterministic):
 *   1. an UNSTAMPED entry (`releaseVersion === null`) is ahead of every release — it is curated but
 *      not yet shipped in one, so it is the newest thing we know about;
 *   2. then by release version, compared SEMANTICALLY;
 *   3. then by shippedAt.
 */
export function compareEntriesNewestFirst(a: ChangelogEntry, b: ChangelogEntry): number {
  const rankA = a.releaseVersion ? 1 : 0;
  const rankB = b.releaseVersion ? 1 : 0;
  if (rankA !== rankB) return rankA - rankB;
  if (a.releaseVersion && b.releaseVersion) {
    const c = compareVersions(b.releaseVersion, a.releaseVersion);
    if (c !== 0) return c;
  }
  return shippedAtMs(b) - shippedAtMs(a);
}

/** The two sections the panel renders: what's new for you, and everything before it. */
export interface ChangelogSections {
  /** Releases the user has not been shown yet — the panel LEADS with these. */
  highlighted: ChangelogEntry[];
  /** Everything else, newest first, scrollable below. */
  history: ChangelogEntry[];
}

/**
 * Split the rows into "new since the version you were running" and "history".
 *
 * Two cases, and the difference between them is the whole point of persisting a last-seen version:
 *
 *  - CATCH-UP (`lastSeen` is older than `current`): highlight every release in `(lastSeen, current]`.
 *    The user may have skipped several, and "what changed since the version I was on" is the
 *    question they are actually asking.
 *  - OTHERWISE (first run, where `lastSeen` was just seeded to `current`, or a re-open): highlight
 *    only the running release. This is the FIRST-RUN RULE — a user who just installed must not be
 *    handed 35 releases.
 *
 * An entry with a null `releaseVersion` is never highlighted (it is not part of any release the
 * user could have been running) but it is always rendered, at the top of the history.
 *
 * If nothing matches — the API has not stamped the running version yet, say — the newest entry is
 * highlighted anyway, so the panel always leads with something rather than opening on a blank.
 */
export function partitionEntries(
  entries: ChangelogEntry[],
  currentVersion: string | null | undefined,
  lastSeenVersion: string | null | undefined,
): ChangelogSections {
  const sorted = [...entries].sort(compareEntriesNewestFirst);
  const current = asString(currentVersion);
  const lastSeen = asString(lastSeenVersion);
  const catchUp = Boolean(current && lastSeen && isNewerVersion(current, lastSeen));

  const isNew = (e: ChangelogEntry): boolean => {
    if (!e.releaseVersion || !current) return false;
    if (catchUp) {
      return (
        isNewerVersion(e.releaseVersion, lastSeen) && compareVersions(e.releaseVersion, current) <= 0
      );
    }
    return compareVersions(e.releaseVersion, current) === 0;
  };

  let highlighted = sorted.filter(isNew);
  let history = sorted.filter((e) => !isNew(e));
  const newest = sorted[0];
  if (highlighted.length === 0 && newest) {
    highlighted = [newest];
    history = sorted.slice(1);
  }
  return { highlighted, history };
}

// --- The auto-open decision -------------------------------------------------------------------

/**
 * What to do on launch, given the running version and the last one we showed What's New for.
 *
 *  - "seed": nothing recorded yet (fresh install, or an upgrade from before this key existed).
 *    Record the current version and show NOTHING unprompted — we cannot know what they came from,
 *    and guessing means dumping the entire backlog at someone who just installed.
 *  - "open": we recorded an older version, so the app has genuinely relaunched onto a new one.
 *    This is the post-update moment the panel exists for.
 *  - "none": same version (already shown), a downgrade, or the version hasn't resolved yet.
 *
 * Pure, so the once-per-version contract is pinned without rendering anything.
 */
export type AutoOpenDecision = "open" | "seed" | "none";

export function autoOpenDecision(
  currentVersion: string | null | undefined,
  lastSeenVersion: string | null | undefined,
): AutoOpenDecision {
  const current = asString(currentVersion);
  if (!current) return "none"; // version hasn't resolved from Rust yet
  const lastSeen = asString(lastSeenVersion);
  if (!lastSeen) return "seed";
  return isNewerVersion(current, lastSeen) ? "open" : "none";
}

// --- Cache ------------------------------------------------------------------------------------

interface CachedChangelog {
  fetchedAt: number;
  entries: ChangelogEntry[];
}

/** Read the last good response, or null. Never throws — a corrupt cache is simply no cache. */
export function readCachedChangelog(): CachedChangelog | null {
  try {
    const raw = localStorage.getItem(CHANGELOG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    const { entries } = parseChangelogPayload(o.entries);
    if (entries.length === 0) return null;
    const fetchedAt = typeof o.fetchedAt === "number" ? o.fetchedAt : 0;
    return { fetchedAt, entries };
  } catch {
    return null;
  }
}

/** Persist a good response. Best-effort — a full/blocked localStorage must not break the panel. */
export function writeCachedChangelog(entries: ChangelogEntry[], fetchedAt: number): void {
  if (entries.length === 0) return;
  try {
    localStorage.setItem(CHANGELOG_CACHE_KEY, JSON.stringify({ fetchedAt, entries }));
  } catch {
    /* ignore — the cache is an optimisation, not a requirement */
  }
}

// --- Fetch ------------------------------------------------------------------------------------

/** The endpoint URL, optionally narrowed to releases after `since`. */
export function changelogUrl(since?: string | null): string {
  const v = asString(since);
  return v ? `${CHANGELOG_API_URL}?since=${encodeURIComponent(v)}` : CHANGELOG_API_URL;
}

/**
 * Load the changelog: live if we can reach it, cached if we can't, empty if we have neither.
 *
 * NEVER throws and NEVER surfaces an error state to the caller. The failure modes here — offline,
 * DNS, a 500, a Tauri capability that doesn't allow the host — all resolve to "show what we have,
 * quietly noting it may be out of date", because a What's New panel that fails closed is worse than
 * one that is slightly stale.
 *
 * Note we deliberately fetch the FULL list rather than `?since=`: the panel renders scrollable
 * history below the new-for-you section, and one response serving both is one round trip and one
 * cache. `changelogUrl` still supports `since` for callers that want the narrow form.
 */
export async function loadChangelog(): Promise<ChangelogSnapshot> {
  const cached = readCachedChangelog();
  // AbortController + setTimeout rather than `AbortSignal.timeout`, which is not present in every
  // runtime this bundle is parsed in (jsdom included). An unbounded fetch would leave the panel on
  // "Loading…" forever, which is the one state worse than showing something stale.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await tauriFetch(changelogUrl(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`changelog fetch failed: ${res.status}`);
    const body = (await res.json()) as unknown;
    const { entries, degraded } = parseChangelogPayload(body);
    if (entries.length === 0) {
      // A well-formed empty answer must not evict a good cache — that is how a transient
      // server-side emptiness turns into a permanently blank panel.
      if (cached) return { entries: cached.entries, stale: true, degraded, fetchedAt: cached.fetchedAt };
      return { entries: [], stale: false, degraded, fetchedAt: null };
    }
    const fetchedAt = Date.now();
    writeCachedChangelog(entries, fetchedAt);
    return { entries, stale: false, degraded, fetchedAt };
  } catch (e) {
    log.warn(SCOPE, "changelog fetch failed — falling back to cache", e);
    if (cached) return { entries: cached.entries, stale: true, degraded: false, fetchedAt: cached.fetchedAt };
    return { entries: [], stale: true, degraded: false, fetchedAt: null };
  } finally {
    clearTimeout(timer);
  }
}
