// The ONE plugin key space, derived from the generated catalog rather than restated.
//
// `PLUGIN_CATALOG` is emitted by `scripts/gen-plugin-catalog.mjs` from Rust's `KNOWN_PLUGINS`
// table in `apps/desktop/src-tauri/src/config.rs`, which is the source of truth for which Claude
// Code plugins Sparkle knows how to pre-enable. Everything below is a FUNCTION of that array —
// the key union, the defaults record, the hydrate resolution and the dotted config paths — so
// adding a plugin is a Rust row plus a generator run, not seven hand edits that can each be
// forgotten.
//
// EVERY DERIVATION IS A PURE FUNCTION OF A CATALOG, and the module constants are those functions
// applied to the real one. That is not ceremony: it is what lets a test hand in a catalog with an
// extra row and assert the row reaches every derived list. A test that only counted the real
// catalog's rows would be vacuous — it would pass against the hardcoded lists this replaced.

import { PLUGIN_CATALOG, type PluginCatalogRow } from "./pluginCatalog.generated";

export { PLUGIN_CATALOG, type PluginCatalogRow };

/** Stable identifiers for the config-backed `[plugins]` flags — the camelCase spelling the store,
 *  the UI and the dotted-path writer all key on.
 *
 *  Derived from the catalog, so this union cannot fall behind the Rust table: a new
 *  `KNOWN_PLUGINS` row becomes a new member the moment the generator runs, and every
 *  `Record<PluginKey, …>` in the app then fails to typecheck until it covers the new key. That
 *  compile error IS the guard — it is what the four hand-maintained lists could not give. */
export type PluginKey = (typeof PLUGIN_CATALOG)[number]["key"];

/** The snake_case `[plugins]` TOML keys, as Rust reads and writes them. */
export type PluginTomlKey = (typeof PLUGIN_CATALOG)[number]["tomlKey"];

/** Every plugin key, in catalog (= Rust table) order. The UI renders its plugin rows by mapping
 *  this, so the pane's row order is the table's order by construction. */
export function pluginKeysOf(catalog: readonly PluginCatalogRow[]): string[] {
  return catalog.map((r) => r.key);
}

/** The shipped default of every row — the frontend mirror of Rust's `default_on` column. Used
 *  until the first config hydrate answers for real. */
export function pluginDefaultsOf(catalog: readonly PluginCatalogRow[]): Record<string, boolean> {
  return Object.fromEntries(catalog.map((r) => [r.key, r.defaultOn]));
}

/** Plugin key → its dotted config path under `[plugins]`. Note the snake_case leaf: the TOML key
 *  is `frontend_design`, not the camelCase store key. */
export function pluginConfigPathsOf(catalog: readonly PluginCatalogRow[]): Record<string, string> {
  return Object.fromEntries(catalog.map((r) => [r.key, `plugins.${r.tomlKey}`]));
}

/** Resolve the store's `pluginsEnabled` from a `[plugins]` payload.
 *
 *  Same `??` back-compat rule the hand-written hydrate block had, applied uniformly: a key absent
 *  from the payload — an older backend, or a `[plugins]` block that never mentions it — falls back
 *  to the row's own default, never to `false`. The bug this shape removes is a row omitted from
 *  the hydrate block entirely, which read as its default forever with every suite green because
 *  nothing could see the omission. */
export function resolvePluginsEnabled(
  fromConfig: Readonly<Record<string, boolean | undefined>> | undefined,
  catalog: readonly PluginCatalogRow[],
): Record<string, boolean> {
  return Object.fromEntries(catalog.map((r) => [r.key, fromConfig?.[r.tomlKey] ?? r.defaultOn]));
}

/** Every plugin key, in catalog order. */
export const PLUGIN_KEYS = pluginKeysOf(PLUGIN_CATALOG) as PluginKey[];

/** Defaults, mirroring the `default_on` column of Rust's `KNOWN_PLUGINS`. */
export const PLUGIN_DEFAULTS = pluginDefaultsOf(PLUGIN_CATALOG) as Record<PluginKey, boolean>;

/** Plugin key → its dotted config path under `[plugins]`. */
export const PLUGINS_CONFIG_PATH = pluginConfigPathsOf(PLUGIN_CATALOG) as Record<
  PluginKey,
  string
>;

/** Store key → the `[plugins]` TOML key Rust reports back in a `PluginInstallOutcome`. */
export function pluginTomlKey(key: PluginKey): PluginTomlKey {
  return PLUGINS_CONFIG_PATH[key].slice("plugins.".length) as PluginTomlKey;
}

/** The reverse: an outcome's TOML key → the store key whose row it belongs to, or undefined for a
 *  plugin this build's UI doesn't know about. */
export function pluginKeyForTomlKey(tomlKey: string): PluginKey | undefined {
  return PLUGIN_CATALOG.find((r) => r.tomlKey === tomlKey)?.key;
}
