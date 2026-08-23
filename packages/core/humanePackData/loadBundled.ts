/**
 * Reads the starter packs off disk.
 *
 * This is deliberately the ONLY file in the feature that touches node builtins.
 * `humanePacks.ts` is pure — it takes `unknown` in and gives `Pack`/`ComplianceCitation`
 * out — so it can be bundled for a renderer, imported by a CLI, or handed packs fetched
 * from a URL. Filesystem loading is one caller among several, and lives here.
 *
 * The packs themselves are plain `.json`, on purpose: a policy person can author one and
 * counsel can review it as a document, without a Sparkle release. `resolveJsonModule` is
 * off in this package's tsconfig and turning it on would make packs a BUILD-TIME
 * dependency, which is the opposite of what this feature is for — so they are read as
 * data at runtime rather than imported.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPacks, type LoadOptions, type LoadResult } from '../humanePacks';

export const BUNDLED_PACK_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute paths of every bundled pack document, sorted for a stable load order. */
export function bundledPackFiles(): string[] {
  return readdirSync(BUNDLED_PACK_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(BUNDLED_PACK_DIR, name));
}

/**
 * Parses each bundled pack. A file that is not valid JSON is reported as an error rather
 * than thrown, so one broken document cannot take the whole gate down.
 */
export function loadBundledPacks(opts: LoadOptions = {}): LoadResult {
  const files = bundledPackFiles();
  const raws: unknown[] = [];
  const readErrors: string[] = [];
  const kept: string[] = [];

  for (const file of files) {
    try {
      raws.push(JSON.parse(readFileSync(file, 'utf8')));
      kept.push(file);
    } catch (err) {
      readErrors.push(`${file}: not readable as JSON — ${(err as Error).message}`);
    }
  }

  const result = loadPacks(raws, {
    ...opts,
    label: opts.label ?? ((i) => kept[i] ?? `pack[${i}]`),
  });
  return { packs: result.packs, errors: [...readErrors, ...result.errors] };
}
