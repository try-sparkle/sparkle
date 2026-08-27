// @vitest-environment jsdom
//
// The Tools pane of the ⋯ settings dialog. Covers: both groups render (toggle rows have a switch,
// showcase rows do NOT); toggling a row routes to the right configActions writer (setAiFeature for
// the AI tools, setToolEnabled for the [tools] flags, setPluginEnabled for the [plugins] flags);
// the AI rows lock + show a hint when the AI master is Off; Learn-more opens the provider URL.
// configActions + plugin-opener are mocked so no IPC fires; the settingsStore is the real one,
// driven per test via setState.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PARTIAL mock, spreading the real module. A vitest mock factory is otherwise EXHAUSTIVE: an
// export the component imports but the object omits is `undefined` at call time — and when the
// omitted one is called in a mount effect (`refreshPluginInstallState`) that isn't a failed
// assertion, it throws on every render and takes the whole file down. Spreading means the next
// writer the pane starts calling can't do that again. Only the writers are stubbed; nothing here
// reaches Tauri at import time.
vi.mock("../services/configActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/configActions")>()),
  setAiFeature: vi.fn().mockResolvedValue(undefined),
  setToolEnabled: vi.fn().mockResolvedValue(undefined),
  setPluginEnabled: vi.fn().mockResolvedValue(undefined),
  setRoborevEnabled: vi.fn().mockResolvedValue(undefined),
  setBuilderIndexEnabled: vi.fn().mockResolvedValue(undefined),
  refreshPluginInstallState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

// Only the IPC call is stubbed. `builderIndexReportFailing` stays REAL, so the tests below drive
// the same derivation the pane ships with instead of a test double that agrees with them by
// construction — the row's decision is what's under test, not a boolean handed to it.
vi.mock("../services/builderIndex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/builderIndex")>()),
  builderIndexStatus: vi.fn(),
}));

import {
  setAiFeature,
  setToolEnabled,
  setPluginEnabled,
  setRoborevEnabled,
  setBuilderIndexEnabled,
  refreshPluginInstallState,
} from "../services/configActions";
import { openUrl } from "@tauri-apps/plugin-opener";
import { builderIndexStatus, type BuilderIndexStatus } from "../services/builderIndex";
import { useSettingsStore, PLUGIN_KEYS, type PluginKey } from "../stores/settingsStore";
import { PLUGIN_CATALOG } from "../stores/pluginCatalog";
import { ToolsPane, TOOLS_CATEGORY_KEYWORDS, TOOL_META } from "./ToolsPane";

/** Seed the store to a known baseline: every AI flag + every tool ON (aiFeatureMode = "all") —
 *  EXCEPT 1Password, which is pinned to its shipped default (off, no vault) rather than left to
 *  whatever a previous test wrote. Without those two lines the tests that read the default depend
 *  on file ordering, and `--shuffle` silently inverts their assertions. */
function seedAllOn() {
  useSettingsStore.setState({
    aiAutoRename: true,
    cloudDictation: true,
    aiComposer: true,
    aiSuggestedActions: true,
    aiAutoApprove: true,
    analyticsEnabled: true,
    beadsEnabled: true,
    githubEnabled: true,
    guardrailsEnabled: true,
    humanebenchEnabled: true,
    roborevEnabled: true,
    // NOT part of "all on": Builder Index and 1Password are the two tools that ship off, and
    // seeding either on here would hide a regression that flipped its default.
    builderIndexEnabled: false,
    builderIndexModalOpen: false,
    onepasswordEnabled: false,
    onepasswordVaultId: null,
    pluginsEnabled: {
      ...useSettingsStore.getState().pluginsEnabled,
      superpowers: true,
      frontendDesign: true,
    },
    // Reset per test: it's a module-level store, so a leftover "installing" from one test would
    // displace the scope hint in whatever test ran next.
    pluginInstallState: {},
  });
}

/** Every AI flag OFF (aiFeatureMode = "off"); tools left on so only the AI lock is under test. */
function seedAiOff() {
  useSettingsStore.setState({
    aiAutoRename: false,
    cloudDictation: false,
    aiComposer: false,
    aiSuggestedActions: false,
    aiAutoApprove: false,
    aiConcierge: false,
    analyticsEnabled: true,
    beadsEnabled: true,
    githubEnabled: true,
    guardrailsEnabled: true,
    humanebenchEnabled: true,
    roborevEnabled: true,
    // Every plugin on, derived from the store's own key set — a hand-listed pair would quietly
    // stop meaning "all on" the next time a plugin is added.
    pluginsEnabled: Object.fromEntries(
      Object.keys(useSettingsStore.getState().pluginsEnabled).map((k) => [k, true]),
    ) as Record<PluginKey, boolean>,
  });
}

/** A MIXED AI state (aiFeatureMode = "some"): the master isn't Off, so the AI rows stay live and
 *  each reflects its own flag (composer on, voiceDictation off). */
function seedAiSome() {
  useSettingsStore.setState({
    aiAutoRename: false,
    cloudDictation: false, // Deepgram off
    aiComposer: true, // some other AI feature on → mode "some"
    aiSuggestedActions: false,
    aiAutoApprove: false,
    analyticsEnabled: true,
    beadsEnabled: true,
    githubEnabled: true,
    guardrailsEnabled: true,
    humanebenchEnabled: true,
    roborevEnabled: true,
    pluginsEnabled: {
      ...useSettingsStore.getState().pluginsEnabled,
      superpowers: true,
      frontendDesign: true,
    },
  });
}

/** A `builder_index_status` reply for a HEALTHY, live reporter, with per-test overrides on top.
 *
 *  Written the way the wire actually looks: `blockedBy` is `null`, never absent. It backs a Rust
 *  `Option<String>` with no `skip_serializing_if`, so serde always emits the key — a fixture that
 *  omitted it would be testing a shape the command cannot produce. */
function statusFixture(over: Partial<BuilderIndexStatus> = {}): BuilderIndexStatus {
  return {
    enabled: true,
    username: "someone",
    hasApiKey: true,
    consented: true,
    // Deliberately NOT a 32-hex string: no assertion here reads this value, and a realistic
    // client id trips gitleaks' entropy rule on the `clientId` key name. Keep it word-shaped.
    clientId: "client-id-for-tests",
    reportDays: 7,
    lastReportAt: Math.floor(Date.now() / 1000) - 30 * 60,
    lastStatus: "Reported 21 row(s) across 7 day(s).",
    blockedBy: null,
    serverUrl: "https://tokenmaxxing.odio.dev",
    ...over,
  };
}

/** Render, then let the Builder Index row's status read resolve INTO the DOM.
 *
 *  Every assertion about that row — the ones expecting no badge above all — has to run after the
 *  fetch has settled. An absence asserted while the promise is still pending is an absence for the
 *  wrong reason, and would pass identically against a build that never renders a badge at all.
 *  That this really does settle is not assumed: the failing-reporter test below uses this same
 *  helper and then finds the badge with a SYNCHRONOUS `getByText`, which it could not do if the
 *  effect were still in flight. */
async function renderSettled(ui: React.ReactElement = <ToolsPane />) {
  render(ui);
  await act(async () => {});
}

beforeEach(() => {
  seedAllOn();
  // Healthy by default, so a test that isn't about the reporter never has to think about it.
  vi.mocked(builderIndexStatus).mockResolvedValue(statusFixture());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ToolsPane", () => {
  it("renders both groups, with switches on toggle rows and none on showcase rows", () => {
    render(<ToolsPane />);
    expect(screen.getByText("Your tools")).toBeTruthy();
    expect(screen.getByText("Built into Sparkle")).toBeTruthy();

    // Exactly the twenty-seven toggleable tools carry a switch. Superpowers is one of them: it
    // used to be an info-only showcase row, and is a real [plugins] toggle since the plugin
    // pre-enable work — a stale showcase copy would claim Sparkle ships something the user can't
    // turn off. The seven "sparkle*" rows come from Sparkle's own published marketplace; the last
    // five in the list below come from four THIRD-PARTY marketplaces (sparkle-s3g2.7), which is
    // why each of those rows names its owner in its own description.
    //
    // Hand-listed on purpose, unlike the derived counts further down: this is the one assertion
    // that says WHICH rows the pane offers, so a new plugin must be added here deliberately. A
    // count derived from the store's key set would accept any row set at all.
    // 19 -> 20. A SILENT SEMANTIC MERGE: `HumaneBench` (this branch) and `Backlog drainer`
    // (origin/main) were added to the hand-listed set on opposite sides, git took both names
    // cleanly, and the count came from one side alone. The list is the source of truth — it is
    // the assertion that says WHICH rows exist — so the number follows it, not the reverse.
    // 20 -> 27: the seven Tier 2 plugin rows (sparkle-s3g2.7).
    expect(screen.getAllByRole("switch")).toHaveLength(27);
    for (const name of [
      "Deepgram voice",
      "Guardrails",
      "HumaneBench",
      "Roborev",
      // Machine-wide autonomous loop, beside Roborev — the user-facing kill-switch for the
      // background backlog drainer (default ON; off uninstalls its launchd supervisor).
      "Backlog drainer",
      "Builder Index",
      // The SECOND reporting destination, and it sits beside the Builder Index deliberately —
      // these are competing leaderboards and the pane is where a user chooses either, both, or
      // neither.
      "Straude",
      "Superpowers",
      "Frontend design",
      // Tier 2, Anthropic's official marketplace.
      "Hookify",
      "Code simplifier",
      "Guardrails skill",
      "Branch freshness",
      "Mutation check",
      "Conflict watch",
      "Secrets skill",
      "Review probes",
      "Pusher",
      // Tier 2, third-party marketplaces — obra/superpowers-marketplace,
      // EveryInc/compound-engineering-plugin, trailofbits/skills, 2389-research/claude-plugins.
      "Elements of style",
      "Double shot latte",
      "Compound engineering",
      "Differential review",
      "Review squad",
      "1Password env backup",
      "Beads",
      "GitHub import",
      "Usage analytics",
    ]) {
      expect(screen.getByRole("switch", { name })).toBeTruthy();
    }

    // The two reporting destinations sit NEXT TO each other. The founder's stated test for this
    // feature is being able to turn either on from one place, so ordering is behaviour here, not
    // decoration.
    const switches = screen.getAllByRole("switch");
    const names = switches.map((s) => s.getAttribute("aria-label") ?? s.textContent ?? "");
    const bi = names.findIndex((n) => n.includes("Builder Index"));
    const st = names.findIndex((n) => n.includes("Straude"));
    expect(bi).toBeGreaterThanOrEqual(0);
    expect(st).toBe(bi + 1);

    // Showcase tools are info-only: present by name, badge shown, but NO switch.
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Claude Code" })).toBeNull();
    expect(screen.getByText("Core")).toBeTruthy();
    // Superpowers no longer double-lists as a "Built-in" showcase row.
    expect(screen.queryByText("Built-in")).toBeNull();
  });

  it("hydrates the plugin rows from the last install pass on mount", () => {
    // The hint on a plugin row comes from `pluginInstallState`, which only exists in the store
    // once someone reads the last pass's outcomes. Without this mount effect a plugin that failed
    // to install at launch renders as a healthy ON switch with no hint.
    render(<ToolsPane />);
    expect(refreshPluginInstallState).toHaveBeenCalledTimes(1);
  });

  it("shows the failure from the last install pass on the plugin's row", () => {
    // The OUTCOME the mount effect exists for: what the hydrated state actually renders. A row
    // whose install failed must say so, rather than showing a healthy ON switch.
    useSettingsStore.setState({
      pluginInstallState: { superpowers: "couldn't reach the marketplace" },
    });
    render(<ToolsPane />);
    expect(screen.getByText("couldn't reach the marketplace")).toBeTruthy();
  });

  it("toggles the [plugins] flags through setPluginEnabled, not setToolEnabled", () => {
    render(<ToolsPane />);
    // These persist to [plugins] (repo-overridable), NOT [tools] (machine-wide) — routing them
    // through setToolEnabled would write the wrong config section entirely.
    fireEvent.click(screen.getByRole("switch", { name: "Superpowers" }));
    expect(setPluginEnabled).toHaveBeenCalledWith("superpowers", false);

    fireEvent.click(screen.getByRole("switch", { name: "Frontend design" }));
    expect(setPluginEnabled).toHaveBeenCalledWith("frontendDesign", false);

    expect(setToolEnabled).not.toHaveBeenCalled();
  });

  it("reflects each plugin flag independently and never AI-locks them", () => {
    seedAiOff(); // first — the seed helpers reset every flag, plugins included
    useSettingsStore.setState({ pluginsEnabled: { ...useSettingsStore.getState().pluginsEnabled, superpowers: true, frontendDesign: false } });
    render(<ToolsPane />);
    const sp = screen.getByRole("switch", { name: "Superpowers" }) as HTMLButtonElement;
    const fd = screen.getByRole("switch", { name: "Frontend design" }) as HTMLButtonElement;
    expect(sp.getAttribute("aria-checked")).toBe("true");
    expect(fd.getAttribute("aria-checked")).toBe("false");
    // They are [plugins] flags, not [ai] features, so the AI master must not disable them.
    expect(sp.disabled).toBe(false);
    expect(fd.disabled).toBe(false);
  });

  it("describes each plugin in one line so the pane says what it buys you", () => {
    render(<ToolsPane />);
    expect(
      screen.getByText("The most-used agent methodology plugin: plan → TDD → review."),
    ).toBeTruthy();
    expect(screen.getByText("Anthropic's official UI-quality skill.")).toBeTruthy();
  });

  it("tells the user a plugin toggle only affects agents created from now on", () => {
    render(<ToolsPane />);
    // Sparkle writes enabledPlugins insert-if-absent and never retracts, so toggling OFF leaves
    // every existing worktree exactly as it was. EVERY plugin row must say so — otherwise the
    // switch reads as broken for every agent already on screen. Counted against the store's own
    // key set, so a new plugin that forgets the note fails here instead of shipping silently.
    const pluginRows = Object.keys(useSettingsStore.getState().pluginsEnabled).length;
    expect(screen.getAllByText("Applies to agents created from now on.")).toHaveLength(pluginRows);
  });

  it("reports the installer's progress and failures on the plugin row", () => {
    // Turning a plugin on shells out to `claude plugin install`, which can take a while or fail
    // (offline, no claude, marketplace outage). That half is invisible to the user unless the row
    // says so — otherwise the switch reads ON while agents never see the plugin.
    // Give EVERY plugin row an install state, so the scope note has nowhere left to render and
    // "displaced" is proven rather than merely outnumbered by rows that still show it.
    const keys = Object.keys(useSettingsStore.getState().pluginsEnabled) as PluginKey[];
    const state = Object.fromEntries(
      keys.map((k, i) => [k, i === 0 ? "installing" : "Sparkle couldn't install"]),
    ) as Record<PluginKey, string>;
    useSettingsStore.setState({ pluginInstallState: state });
    render(<ToolsPane />);
    expect(screen.getByText("Installing…")).toBeTruthy();
    expect(screen.getAllByText("Sparkle couldn't install")).toHaveLength(keys.length - 1);
    // The scope note is displaced while there's something more urgent to say, and only then.
    expect(screen.queryByText("Applies to agents created from now on.")).toBeNull();
  });

  // THE PANE'S PLUGIN ROWS ARE DERIVED FROM THE CATALOG, and this is what says so.
  //
  // The vacuous shape here would be "the pane renders 16 plugin rows" — true before the rows were
  // derived, so it proves nothing. What can only pass on a derived implementation is set equality
  // against `PLUGIN_KEYS`, which is itself a function of the generated catalog: a future refactor
  // that re-hardcodes the row array renders whatever it hardcoded, and a catalog row it forgot
  // goes red here instead of silently never appearing in Settings → Tools. That silent
  // never-appearing is the defect this bead was filed about.
  it("renders one row per CATALOG key, in catalog order, wired to that key", () => {
    render(<ToolsPane />);

    // Every catalog key renders a row bearing its TOOL_META name — the derivation reaching the DOM.
    const rendered = screen
      .getAllByTestId("tool-row")
      .map((row) => row.querySelector("span")?.textContent ?? "");
    const pluginNames = PLUGIN_KEYS.map((k) => TOOL_META[k].name);
    for (const name of pluginNames) {
      expect(rendered, `no Tools row for catalog key "${name}"`).toContain(name);
    }

    // …and in the catalog's own order, which is the Rust table's order. The pane has no second
    // ordering to keep in sync: the row order IS the catalog's, by construction.
    const pluginPositions = pluginNames.map((n) => rendered.indexOf(n));
    expect(pluginPositions).toEqual([...pluginPositions].sort((a, b) => a - b));

    // Each row's switch calls setPluginEnabled with ITS OWN key. A derived row array that indexed
    // the catalog wrongly — every row toggling the first plugin — renders identically and would
    // pass a count or a name check; only driving each switch can tell them apart.
    for (const key of PLUGIN_KEYS) {
      vi.mocked(setPluginEnabled).mockClear();
      fireEvent.click(screen.getByRole("switch", { name: TOOL_META[key].name }));
      expect(setPluginEnabled, `the "${TOOL_META[key].name}" switch does not toggle "${key}"`)
        .toHaveBeenCalledWith(key, expect.any(Boolean));
    }
  });

  it("gives every catalog row a Learn more link built from its own plugin name", () => {
    // The sparkle* urls are derived from each row's plugin name, so a new catalog row cannot get a
    // link pointing at a folder that does not exist. Asserted as a SIDE EFFECT — click the link and
    // read what was opened — rather than by re-deriving the string this test would then agree with.
    render(<ToolsPane />);
    for (const row of PLUGIN_CATALOG) {
      vi.mocked(openUrl).mockClear();
      fireEvent.click(
        screen.getByRole("button", { name: `Learn more about ${TOOL_META[row.key].name}` }),
      );
      const [opened] = vi.mocked(openUrl).mock.calls[0] ?? [];
      expect(opened, `no Learn more target for catalog row "${row.key}"`).toMatch(/^https:\/\//);
      if (row.plugin.startsWith("sparkle-")) {
        expect(opened).toBe(
          `https://github.com/try-sparkle/marketplace/tree/main/plugins/${row.plugin}`,
        );
      }
    }
  });

  it("links Frontend design at the repo we actually install from", () => {
    // The row shipped pointing at anthropics/claude-plugins-public, which 404s. The live
    // marketplace repo is anthropics/claude-plugins-official (the same one config.rs installs
    // from); a Rust test pins the two constants together.
    render(<ToolsPane />);
    fireEvent.click(screen.getByRole("button", { name: "Learn more about Frontend design" }));
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/frontend-design",
    );
  });

  it("toggles Roborev through setRoborevEnabled (its own daemon+hooks side-effect writer)", () => {
    render(<ToolsPane />);
    const roborev = screen.getByRole("switch", { name: "Roborev" }) as HTMLButtonElement;
    // Never AI-locked: it's a [tools] flag, not an [ai] feature.
    expect(roborev.disabled).toBe(false);
    expect(roborev.getAttribute("aria-checked")).toBe("true");
    // Starts on → clicking it turns roborev off via the dedicated writer (not setToolEnabled).
    fireEvent.click(roborev);
    expect(setRoborevEnabled).toHaveBeenCalledWith(false);
    expect(setToolEnabled).not.toHaveBeenCalled();
  });

  it("toggles a [tools] flag through setToolEnabled", () => {
    render(<ToolsPane />);
    // Beads starts on → clicking it writes false.
    fireEvent.click(screen.getByRole("switch", { name: "Beads" }));
    expect(setToolEnabled).toHaveBeenCalledWith("beads", false);
  });

  it("toggles Guardrails through the [tools].guardrails flag (a non-AI tool, never locked)", () => {
    render(<ToolsPane />);
    const guardrails = screen.getByRole("switch", { name: "Guardrails" }) as HTMLButtonElement;
    expect(guardrails.disabled).toBe(false);
    fireEvent.click(guardrails);
    expect(setToolEnabled).toHaveBeenCalledWith("guardrails", false);
  });

  it("HumaneBench copy states what the gate now does, and does not overclaim that it blocks", () => {
    // THE RATCHET, INVERTED — and inverted rather than deleted on purpose.
    //
    // Its previous job was to stop the copy promising protection while nothing read the flag.
    // The consumer has landed (.github/workflows/humane-gate.yml runs scope -> render -> judge
    // on every pull request), so that under-claim is now the false one: a user reading "still
    // being built" concludes their PRs are NOT being scored, and they are.
    //
    // But the OPPOSITE over-claim is still available and still wrong. A failing `HumaneBench`
    // check does not hold a merge until an admin adds it to ruleset 18343818's required
    // contexts, which bead sparkle-4eqjil deliberately orders LAST — after two green runs on
    // real pull requests. So the copy must claim the scoring (true today) and must qualify the
    // blocking (not true today). A switch that overstates its protection is the exact failure
    // this test was written for; only the direction of the lie has changed.
    const desc = TOOL_META.humanebench.desc;

    // The stale under-claim must not come back.
    expect(desc).not.toMatch(/still being built|no review runs yet|records your preference/i);

    // The true claim must be present: it scores, and it posts the reasoning.
    expect(desc).toMatch(/scores/i);
    expect(desc).toMatch(/posts|reasoning/i);

    // Any claim about holding a merge must carry the condition that makes it true.
    if (/blocks? the merge|holds? (?:back|a merge|the merge)|gates? the merge/i.test(desc)) {
      expect(desc).toMatch(/once an admin|ruleset|required check/i);
    }
    // And it must never assert the unconditional present tense.
    expect(desc).not.toMatch(/always blocks|blocks every|holds every merge/i);

    // THE THIRD LIE, and the one this row's own SWITCH tells (bead `sparkle-g4krv1`).
    //
    // Everything above judges what the copy says about the REVIEW. This judges what it lets a
    // reader infer about the TOGGLE beside it, which is a different claim and was the false one:
    // the copy described a review, sat under a switch, and so read as the switch that governs it.
    // It does not. Measured, `tools.humanebench` has no consumer anywhere — and even once it has
    // one, that consumer cannot reach this review, which is repo-side
    // (.github/workflows/humane-gate.yml, triggered by the pull request) and deliberately out of
    // reach of a machine-wide desktop setting, because a checkout that could disable its own
    // humaneness gate is the thing the machine-wide scope exists to prevent. A user who flips
    // this off believing they have opted out has not opted out: their PRs are still scored and
    // still get a verdict comment. A switch that overstates its protection is the exact failure
    // this test was written for, and this is the sharpest form of it.
    //
    // Note the shape of the pair below — an absent lie is NOT the same fact as a present truth.
    // Merely deleting "Off skips the review entirely" leaves a reader with no statement at all
    // about what the switch does, which is the inference that was wrong in the first place. So
    // the negative and the positive are both required, and neither alone would go red on the
    // copy this replaced.
    // The negative is written with a lookbehind on purpose: the honest copy has to SAY "does not
    // turn it off", so a naive /turns? it off/ would red the very sentence it exists to require.
    // What is banned is the AFFIRMATIVE claim, in each form it has actually taken here.
    expect(desc).not.toMatch(
      /(?<!does not )(?<!doesn't )(?:turns?|switch(?:es)?|shuts?) (?:it|the review|the gate) off|off skips|skips the review|disables the review|opts? you out/i,
    );
    expect(desc).toMatch(/does not turn it off|runs on every pull request|regardless of this/i);
  });

  it("toggles HumaneBench through the [tools].humanebench flag (never AI-locked)", () => {
    // seedAiOff FIRST, because this is the ONLY interleaving in which the claim is falsifiable.
    // The row's disabled state is `disabled={t.ai ? aiOff : false}`, so under the file's default
    // seedAllOn the expression is false for EVERY row whatever `ai` says — adding `ai: true` to
    // the humanebench row (the exact regression this test names) would leave it green.
    seedAiOff();
    render(<ToolsPane />);
    const humanebench = screen.getByRole("switch", { name: "HumaneBench" }) as HTMLButtonElement;
    // NOT an `ai: true` row: the humaneness gate must not go dark just because the AI master is
    // off, and it must not be reachable only through some other tool's consent modal.
    expect(humanebench.disabled).toBe(false);
    expect(humanebench.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(humanebench);
    expect(setToolEnabled).toHaveBeenCalledWith("humanebench", false);
  });

  it("paints HumaneBench ON when nothing has ever been configured", () => {
    // The shipped default, read off the row the user actually sees. Seeded to the store's OWN
    // initial value rather than a hand-set `true`, so a regression that flipped the default to
    // false lands here rather than being papered over by the seed.
    useSettingsStore.setState({
      humanebenchEnabled: useSettingsStore.getInitialState().humanebenchEnabled,
    });
    render(<ToolsPane />);
    const humanebench = screen.getByRole("switch", { name: "HumaneBench" });
    expect(humanebench.getAttribute("aria-checked")).toBe("true");
  });

  it("toggles Deepgram through the [ai].voice_dictation feature", () => {
    render(<ToolsPane />);
    fireEvent.click(screen.getByRole("switch", { name: "Deepgram voice" }));
    expect(setAiFeature).toHaveBeenCalledWith("voiceDictation", false);
  });

  it("locks the AI tools (disabled + off) and shows a hint when the AI master is Off", () => {
    seedAiOff();
    render(<ToolsPane />);
    const deepgram = screen.getByRole("switch", { name: "Deepgram voice" }) as HTMLButtonElement;
    expect(deepgram.disabled).toBe(true);
    expect(deepgram.getAttribute("aria-checked")).toBe("false");
    // A hint on the AI row.
    expect(screen.getAllByText("Turn on AI features to use this tool.")).toHaveLength(1);
    // A clicked locked switch writes nothing.
    fireEvent.click(deepgram);
    expect(setAiFeature).not.toHaveBeenCalled();
  });

  it("keeps the AI rows live in 'some' mode, each reflecting its own flag", () => {
    seedAiSome();
    render(<ToolsPane />);
    const deepgram = screen.getByRole("switch", { name: "Deepgram voice" }) as HTMLButtonElement;
    // Master isn't Off, so the AI row is not locked...
    expect(deepgram.disabled).toBe(false);
    // ...and it mirrors its individual flag (voiceDictation off).
    expect(deepgram.getAttribute("aria-checked")).toBe("false");
    // No lock hint in this state.
    expect(screen.queryByText("Turn on AI features to use this tool.")).toBeNull();
  });

  it("does not lock the non-AI tools when the AI master is Off", () => {
    seedAiOff();
    render(<ToolsPane />);
    const beads = screen.getByRole("switch", { name: "Beads" }) as HTMLButtonElement;
    expect(beads.disabled).toBe(false);
    fireEvent.click(beads);
    expect(setToolEnabled).toHaveBeenCalledWith("beads", false);
  });

  it("opens the provider URL from Learn more (scoped to the specific tool row)", () => {
    render(<ToolsPane />);
    // Target Deepgram's link by its accessible name so the assertion doesn't ride on row order.
    fireEvent.click(screen.getByRole("button", { name: "Learn more about Deepgram voice" }));
    expect(openUrl).toHaveBeenCalledWith("https://deepgram.com");
    // A plugin row's link too (Superpowers → GitHub).
    fireEvent.click(screen.getByRole("button", { name: "Learn more about Superpowers" }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/obra/superpowers");
  });

  describe("roborev auth warning", () => {
    // Note: the Roborev row's own description mentions "your Claude login", so this asserts on
    // wording unique to the warning — otherwise the happy-path case matches the description and
    // passes vacuously.
    const WARNING = "Roborev found claude but couldn't sign in, so your commits won't be reviewed.";

    it("shows no warning when the auth self-test is happy", () => {
      useSettingsStore.setState({ roborevAuthWarning: null });
      render(<ToolsPane />);
      expect(screen.queryByText(WARNING)).toBeNull();
    });

    it("surfaces the warning on the Roborev row so a non-reviewing daemon can't look healthy", () => {
      useSettingsStore.setState({ roborevAuthWarning: WARNING });
      render(<ToolsPane />);
      expect(screen.getByText(WARNING)).toBeTruthy();
    });
  });

  describe("Builder Index row", () => {
    it("ships OFF and says what it publishes", () => {
      render(<ToolsPane />);
      const sw = screen.getByRole("switch", { name: "Builder Index" });
      expect(sw.getAttribute("aria-checked")).toBe("false");
      expect(
        screen.getByText(
          /Publish your daily token totals to the public tokenmaxxing leaderboard\. Aggregates only, never your code or prompts\./,
        ),
      ).toBeTruthy();
    });

    it("routes its toggle through setBuilderIndexEnabled (which gates on consent), not setToolEnabled", () => {
      render(<ToolsPane />);
      fireEvent.click(screen.getByRole("switch", { name: "Builder Index" }));
      expect(setBuilderIndexEnabled).toHaveBeenCalledWith(true);
      // Turning it on must NOT write the config directly — the consent modal owns that write.
      expect(setToolEnabled).not.toHaveBeenCalled();
    });

    it("offers a way back into its settings once it's on", () => {
      useSettingsStore.setState({ builderIndexEnabled: true });
      render(<ToolsPane />);
      fireEvent.click(screen.getByRole("button", { name: "Manage your Builder Index settings" }));
      expect(useSettingsStore.getState().builderIndexModalOpen).toBe(true);
    });
  });

  // A reporter that posts every two hours and has ZERO of it stored is the failure this row exists
  // for: the server answers 200, `discard_reason` catches it, and the explanation is written to
  // disk every cycle — into a modal nobody opens. The founder found out by reading his own public
  // profile and noticing the numbers were wrong. Each test below asserts what he would SEE.
  describe("Builder Index row — a failing reporter", () => {
    const FAILED = "Not publishing";
    const FAIL_HINT =
      "Your last report didn't reach the leaderboard — open Builder Index settings for the details";
    const MANAGE = "Manage your Builder Index settings";
    const DAY = 24 * 60 * 60;

    beforeEach(() => {
      useSettingsStore.setState({ builderIndexEnabled: true });
    });

    it("badges the row when the last cycle didn't land", async () => {
      // The measured message, verbatim from builder_index.rs's `discard_reason`.
      vi.mocked(builderIndexStatus).mockResolvedValue(
        statusFixture({
          lastStatus:
            "Last report failed — the server FROZE this profile — it accepted the request and kept none of it, so the Builder Index will keep showing the last snapshot.",
          lastReportAt: Math.floor(Date.now() / 1000) - 21 * DAY,
        }),
      );
      await renderSettled();
      expect(screen.getByText(FAILED)).toBeTruthy();
    });

    it("points at the modal for the reason instead of restating it in the row", async () => {
      vi.mocked(builderIndexStatus).mockResolvedValue(
        statusFixture({ lastStatus: "Last report failed — server returned 500." }),
      );
      await renderSettled();
      // The row says something is wrong and offers the click; the server's own words stay in the
      // dialog that already renders them.
      expect(screen.queryByText(/server returned 500/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: FAIL_HINT }));
      expect(useSettingsStore.getState().builderIndexModalOpen).toBe(true);
    });

    it("says nothing when the last report landed", async () => {
      await renderSettled(); // the healthy default fixture
      expect(screen.queryByText(FAILED)).toBeNull();
      expect(screen.getByRole("button", { name: MANAGE })).toBeTruthy();
    });

    it("does NOT badge a reporter that is merely off or unconsented", async () => {
      // THE DISCRIMINATION THAT MATTERS. `blockedBy` means no report would go out at all — the
      // normal state of an install that never opted in — and it must win even over a stored
      // failure message left behind from before the user switched the tool off. Getting this
      // wrong puts a red badge on every default install, which is worse than the silence.
      vi.mocked(builderIndexStatus).mockResolvedValue(
        statusFixture({
          blockedBy: "waiting for consent",
          consented: false,
          lastReportAt: null,
          lastStatus: "Last report failed — network error: dns error.",
        }),
      );
      await renderSettled();
      expect(screen.queryByText(FAILED)).toBeNull();
    });

    it("badges a live reporter whose last SUCCESS is many cycles old, whatever the message says", async () => {
      // The signal that survives a Rust reword: `last_report_at` advances only on the success
      // branch of `record_outcome`, so a three-day-old success under a 2h cadence is a reporter
      // whose cycles are being discarded — even with a message that reads like a clean post.
      vi.mocked(builderIndexStatus).mockResolvedValue(
        statusFixture({
          lastStatus: "Reported 21 row(s) across 7 day(s).",
          lastReportAt: Math.floor(Date.now() / 1000) - 3 * DAY,
        }),
      );
      await renderSettled();
      expect(screen.getByText(FAILED)).toBeTruthy();
    });

    it("says nothing before the first cycle has recorded anything", async () => {
      // Five minutes after launch a freshly-consented install has no outcome yet. Nothing has
      // failed, so nothing should be claimed to have.
      vi.mocked(builderIndexStatus).mockResolvedValue(
        statusFixture({ lastStatus: null, lastReportAt: null }),
      );
      await renderSettled();
      expect(screen.queryByText(FAILED)).toBeNull();
      expect(screen.getByRole("button", { name: MANAGE })).toBeTruthy();
    });

    it("treats an unreadable status as no news, not as a failure", async () => {
      vi.mocked(builderIndexStatus).mockRejectedValue(new Error("ipc down"));
      await renderSettled();
      expect(screen.queryByText(FAILED)).toBeNull();
    });

    it("never reaches for status while the tool is switched off", async () => {
      useSettingsStore.setState({ builderIndexEnabled: false });
      await renderSettled();
      expect(builderIndexStatus).not.toHaveBeenCalled();
      expect(screen.queryByText(FAILED)).toBeNull();
    });
  });

  it("filters its rows by the query prop (pane-row search)", () => {
    render(<ToolsPane query="github" />);
    // Only the matching tool survives; unrelated rows and the empty group vanish.
    expect(screen.getByRole("switch", { name: "GitHub import" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Beads" })).toBeNull();
    expect(screen.queryByText("Built into Sparkle")).toBeNull();
  });
});

describe("ToolsPane — 1Password env backup row", () => {
  it("is the one tool that reads OFF from the shared all-on baseline", () => {
    // seedAllOn() (the beforeEach) turns every OTHER tool on but leaves this one at its default.
    // That default is deliberate: without the `op` CLI and a chosen vault the tool cannot do
    // anything, so an on switch would claim a capability the install doesn't have.
    render(<ToolsPane />);
    const sw = screen.getByRole("switch", { name: "1Password env backup" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("routes its toggle through setToolEnabled with the onepassword key", () => {
    render(<ToolsPane />);
    fireEvent.click(screen.getByRole("switch", { name: "1Password env backup" }));
    expect(setToolEnabled).toHaveBeenCalledWith("onepassword", true);
  });

  it("warns that nothing is being backed up while no vault is chosen", () => {
    // The dangerous state: the switch is ON, so it LOOKS like backups are happening, but without a
    // vault nothing is. The row has to say so.
    useSettingsStore.setState({ onepasswordEnabled: true, onepasswordVaultId: null });
    render(<ToolsPane />);
    expect(screen.getByText("Open Settings → 1Password to choose a vault and start backing up your .env files.")).toBeTruthy();
  });

  it("drops the warning once a vault is chosen", () => {
    useSettingsStore.setState({ onepasswordEnabled: true, onepasswordVaultId: "vault-abc" });
    render(<ToolsPane />);
    expect(screen.queryByText("Open Settings → 1Password to choose a vault and start backing up your .env files.")).toBeNull();
  });

  it.each(["dotenv", "secrets", "vault", "onepassword", "1password", "env"])(
    "is findable by searching %j",
    (q) => {
      render(<ToolsPane query={q} />);
      expect(screen.getByRole("switch", { name: "1Password env backup" })).toBeTruthy();
    },
  );

  it("stays quiet about the vault while the tool is off", () => {
    // Off is a coherent state, not a misconfiguration — don't nag about a vault nobody needs yet.
    useSettingsStore.setState({ onepasswordEnabled: false, onepasswordVaultId: null });
    render(<ToolsPane />);
    expect(screen.queryByText("Open Settings → 1Password to choose a vault and start backing up your .env files.")).toBeNull();
  });

});

// Every term the ⋯ rail advertises for the Tools category has to be answerable by a row in this
// pane. A keyword no row matches surfaces the category and then renders "No tools match" — a dead
// end worse than not matching at all, and the class of bug this pins is wider than any one row.
describe("ToolsPane — the rail's keywords all land on a row", () => {
  it.each([...new Set(TOOLS_CATEGORY_KEYWORDS.split(/\s+/).filter(Boolean))])(
    "matches at least one row for %j",
    (token) => {
      render(<ToolsPane query={token} />);
      // Assert a row SURVIVED, not merely that a particular empty-state string is absent — the
      // absence form would pass vacuously forever if that copy were ever reworded.
      expect(countVisibleRows()).toBeGreaterThan(0);
    },
  );
});

/** How many rows the pane is currently showing, toggle AND showcase.
 *
 *  Counted from the DOM (`data-testid="tool-row"`), NOT by looking up TOOL_META names. Deriving the
 *  count from the table cannot see a row that isn't in the table — which is precisely the drift the
 *  converse test below exists to catch, and showcase rows have no `switch` to fall back on. It also
 *  replaces the hardcoded `["Claude Code", "Superpowers"]` this file used to repeat in three
 *  places, where a renamed showcase row went silently uncounted instead of failing something. */
function countVisibleRows(): number {
  return screen.queryAllByTestId("tool-row").length;
}

// The CONVERSE direction, and the one that was previously true only by coincidence. Rows match on
// name + desc + keywords, but the rail's advertised string is derived from a table — so a row whose
// NAME carries a term the rail doesn't advertise is unreachable: the query matches no category, the
// rail renders "No settings match", and this pane is never reached to do the matching. That is a
// worse dead end than the one above, because the user never even sees the category.
describe("ToolsPane — every word a row is searchable by is advertised by the rail", () => {
  // The CONVERSE direction, and the one that was wrong in production. Rows match on
  // name + desc + keywords; the rail matched keywords only (then keywords + names). Anything living
  // just in a `desc` was a live dead end — it matched the row but no CATEGORY, so the rail rendered
  // "No settings match" and this pane was never reached.
  //
  // The derivation tests below deliberately do NOT scrape rendered text: the pane's own row chrome
  // (hints, badges, the Learn-more link) is not part of the searchable surface, and a textContent
  // scrape both picks that up and welds adjacent elements together ("voice"+"AI" → "voiceai"). The
  // two DOM tests that follow them read text on purpose, via queryAllByText — which matches direct
  // text nodes, so nothing is welded — because set equality between the table and the rendered rows
  // is not a fact any derivation from the table can establish.

  /** Words worth searching for: drop punctuation and single characters. */
  const searchableTokens = (text: string) =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2);

  it("advertises every word of every row's name and description", () => {
    // Guards the specific regression: someone dropping `t.desc` from the derivation restores the
    // dead ends. Reads TOOL_META through the exported string, which is what the rail consumes.
    const advertised = new Set(searchableTokens(TOOLS_CATEGORY_KEYWORDS));
    const missing: string[] = [];
    for (const meta of Object.values(TOOL_META)) {
      for (const token of new Set(searchableTokens(`${meta.name} ${meta.desc}`))) {
        if (!advertised.has(token)) missing.push(`${meta.name} → "${token}"`);
      }
    }
    expect(missing).toEqual([]);
  });

  // The assertion above compares TOOL_META against the string DERIVED from it, so on its own it
  // only catches someone dropping `desc`/`name` out of the derivation. It says nothing about what
  // the rows actually RENDER — and an inlined `desc:` on a row literal is the same live dead end
  // (the row matches a word, no category does, the rail says "No settings match"). The rows spread
  // `...TOOL_META.x` so that divergence is unrepresentable; this pins it from the DOM side, which
  // is the half the derivation test can't see.
  it("renders every row's name and desc from TOOL_META — nothing inlined past the rail", () => {
    render(<ToolsPane />);
    for (const meta of Object.values(TOOL_META)) {
      // queryAllByText, not queryByText: the latter THROWS on multiple matches, which would report
      // a duplicated string as an unrelated crash instead of this assertion's message. Exactly one
      // is also the stronger fact — two rows rendering the same name is its own bug.
      expect(screen.queryAllByText(meta.name), `expected exactly one row named "${meta.name}"`).toHaveLength(1);
      expect(
        screen.queryAllByText(meta.desc),
        `the row "${meta.name}" does not render TOOL_META's desc — an inlined desc is a word the rail never advertises`,
      ).toHaveLength(1);
    }
  });

  it("renders NO row that isn't in TOOL_META — the direction that catches a brand-new row", () => {
    // The test above only proves TOOL_META ⊆ rendered. The realistic drift isn't editing an existing
    // row (that now fails) — it's ADDING one with inline strings: `{ key: "chief", name: "Chief",
    // desc: "Brainstorming co-pilot", … }` compiles, renders, matches "brainstorming", is advertised
    // by no category, and reproduces the "No settings match" dead end with every other test green.
    // `name: string` accepts any literal, so the type can't refuse it; counting can.
    render(<ToolsPane />);
    const tableNames = new Set<string>(Object.values(TOOL_META).map((m) => m.name));

    // Scrape each RENDERED row's name and demand it be in the table. This covers showcase rows too
    // — they have no switch, so an aria-label sweep misses them entirely, and a count derived from
    // TOOL_META could never notice an extra one.
    for (const row of screen.getAllByTestId("tool-row")) {
      const name = row.querySelector("span")?.textContent ?? "";
      expect(
        tableNames.has(name),
        `the row "${name}" is not in TOOL_META, so the rail never advertises it`,
      ).toBe(true);
    }
    // …and the counts agree in both directions: every table entry renders (asserted above) and the
    // pane shows nothing beyond them.
    expect(countVisibleRows(), "the pane renders a row that is not in TOOL_META").toBe(
      Object.keys(TOOL_META).length,
    );
  });

  it("surfaces a row for the desc-only words that used to dead-end", () => {
    // Named explicitly so the fix can't silently rot back. Each of these appears ONLY in a row's
    // description — none is in any keyword string — so each one exercises the desc half.
    for (const token of [
      "repositories",
      "masked",
      "anonymous",
      "typechecks",
      "worktrees",
      "on-device",
    ]) {
      expect(
        TOOLS_CATEGORY_KEYWORDS.toLowerCase().includes(token),
        `the rail must advertise "${token}" or searching it dead-ends before the pane`,
      ).toBe(true);
      render(<ToolsPane query={token} />);
      const rows = countVisibleRows();
      cleanup();
      expect(rows, `searching "${token}" found no row`).toBeGreaterThan(0);
    }
  });

  it("surfaces a row when searching any single word of any row name", () => {
    // aria-label is the row's real rendered name, so this catches a row whose name diverges from
    // the TOOL_META entry it is supposed to render.
    render(<ToolsPane />);
    const labels = screen.getAllByRole("switch").map((el) => el.getAttribute("aria-label") ?? "");
    cleanup();
    expect(labels.length).toBeGreaterThan(0);

    for (const label of [...labels, "Claude Code", "Superpowers"]) {
      for (const token of label.split(/\s+/).filter(Boolean)) {
        render(<ToolsPane query={token} />);
        const rows = countVisibleRows();
        cleanup();
        expect(rows, `searching "${token}" (from row "${label}") found no row`).toBeGreaterThan(0);
      }
    }
  });
});
