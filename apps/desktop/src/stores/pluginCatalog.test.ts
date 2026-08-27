// The plugin catalog is DERIVED, and this is the test that says so.
//
// THE VACUOUS SHAPE THIS AVOIDS. "PLUGIN_DEFAULTS has 16 entries" and "every catalog key is in
// PLUGINS_CONFIG_PATH" both pass against the seven hardcoded lists this replaced — they were true
// before the change, so they prove nothing. The assertion that can only pass on a derived
// implementation is: hand in a catalog with a row that does not exist, and watch the row come out
// of every derived list. A hardcoded list cannot contain a key nobody hardcoded.
//
// So each test below builds `withExtraRow` — the real catalog plus one synthetic row — and asserts
// the synthetic row's SIDE EFFECT: it appears in the keys, it carries its own default, it gets a
// dotted path built from its own TOML key, and the hydrate resolves it. A future refactor that
// re-introduces a literal list goes red here, which is the regression this bead was filed about.

import { describe, it, expect } from "vitest";
import {
  PLUGIN_CATALOG,
  PLUGIN_DEFAULTS,
  PLUGIN_KEYS,
  PLUGINS_CONFIG_PATH,
  pluginConfigPathsOf,
  pluginDefaultsOf,
  pluginKeyForTomlKey,
  pluginKeysOf,
  pluginTomlKey,
  resolvePluginsEnabled,
  type PluginCatalogRow,
} from "./pluginCatalog";

/** A row that exists in NO hardcoded list anywhere in the app — which is the entire point. Its
 *  `defaultOn: true` is deliberate: the derived default has to carry the row's OWN value, not a
 *  blanket fallback, and `true` is distinguishable from the `false` an unknown key resolves to. */
const NEW_ROW: PluginCatalogRow = {
  key: "brandNewPlugin",
  tomlKey: "brand_new_plugin",
  plugin: "brand-new-plugin",
  defaultOn: true,
};

const withExtraRow: readonly PluginCatalogRow[] = [...PLUGIN_CATALOG, NEW_ROW];

describe("a new catalog row reaches every derived list", () => {
  it("appears in the key list, in catalog order", () => {
    const keys = pluginKeysOf(withExtraRow);
    expect(keys).toContain("brandNewPlugin");
    // Order matters: the Tools pane renders its plugin rows by mapping this, so the array's order
    // IS the pane's row order. A derivation that sorted or grouped would move every existing row.
    expect(keys).toEqual([...pluginKeysOf(PLUGIN_CATALOG), "brandNewPlugin"]);
  });

  it("carries its OWN default into the defaults record", () => {
    const defaults = pluginDefaultsOf(withExtraRow);
    expect(defaults.brandNewPlugin).toBe(true);
    // …and a row whose default is `false` keeps that, so the derivation is reading the column
    // rather than defaulting everything to on.
    expect(defaults).toMatchObject(pluginDefaultsOf(PLUGIN_CATALOG));
    expect(pluginDefaultsOf([{ ...NEW_ROW, defaultOn: false }]).brandNewPlugin).toBe(false);
  });

  it("gets a dotted config path built from its own TOML key, not its store key", () => {
    // The snake_case leaf is the trap this replaces: the TOML key is `brand_new_plugin`, and a
    // path built from the camelCase store key would parse, write nothing Rust reads, and never
    // explain itself.
    expect(pluginConfigPathsOf(withExtraRow).brandNewPlugin).toBe("plugins.brand_new_plugin");
  });

  it("is resolved by the config hydrate — both from the file and from its default", () => {
    // The bug this shape removes: a row omitted from the old hand-written hydrate block read as
    // its default forever, with every suite green, because nothing could see the omission.
    expect(resolvePluginsEnabled({ brand_new_plugin: false }, withExtraRow).brandNewPlugin).toBe(
      false,
    );
    // Absent from the payload — an older backend — falls back to the row's own default, never to
    // `false`.
    expect(resolvePluginsEnabled({}, withExtraRow).brandNewPlugin).toBe(true);
    expect(resolvePluginsEnabled(undefined, withExtraRow).brandNewPlugin).toBe(true);
  });

  it("does not disturb the rows already in the catalog", () => {
    // The other half of the side effect: adding a row must add exactly one entry everywhere, not
    // re-key or re-default the sixteen that were already there.
    const before = resolvePluginsEnabled(undefined, PLUGIN_CATALOG);
    const after = resolvePluginsEnabled(undefined, withExtraRow);
    expect(after).toMatchObject(before);
    expect(Object.keys(after).length).toBe(Object.keys(before).length + 1);
  });
});

describe("the derived module constants are those functions applied to the real catalog", () => {
  // Not a restatement of the tests above: this is what pins the EXPORTED constants — the things
  // the rest of the app actually imports — to the derivations, so a future edit cannot quietly
  // hand-write one of them back while the pure functions stay honest.
  it("PLUGIN_KEYS / PLUGIN_DEFAULTS / PLUGINS_CONFIG_PATH are derivations, not literals", () => {
    expect(PLUGIN_KEYS).toEqual(pluginKeysOf(PLUGIN_CATALOG));
    expect(PLUGIN_DEFAULTS).toEqual(pluginDefaultsOf(PLUGIN_CATALOG));
    expect(PLUGINS_CONFIG_PATH).toEqual(pluginConfigPathsOf(PLUGIN_CATALOG));
  });

  it("round-trips a store key through its TOML key and back", () => {
    for (const row of PLUGIN_CATALOG) {
      expect(pluginTomlKey(row.key)).toBe(row.tomlKey);
      expect(pluginKeyForTomlKey(row.tomlKey)).toBe(row.key);
    }
  });

  it("returns undefined for a TOML key this build has no row for", () => {
    // A newer backend can report an outcome for a plugin this build's UI doesn't know about. That
    // must be ignored, not mapped onto whichever row happens to sort first.
    expect(pluginKeyForTomlKey("brand_new_plugin")).toBeUndefined();
  });
});
