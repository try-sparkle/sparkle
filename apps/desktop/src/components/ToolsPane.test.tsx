// @vitest-environment jsdom
//
// The Tools pane of the ⋯ settings dialog. Covers: both groups render (toggle rows have a switch,
// showcase rows do NOT); toggling a row routes to the right configActions writer (setAiFeature for
// the AI tools, setToolEnabled for the [tools] flags, setPluginEnabled for the [plugins] flags);
// the AI rows lock + show a hint when the AI master is Off; Learn-more opens the provider URL.
// configActions + plugin-opener are mocked so no IPC fires; the settingsStore is the real one,
// driven per test via setState.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

import {
  setAiFeature,
  setToolEnabled,
  setPluginEnabled,
  setRoborevEnabled,
  setBuilderIndexEnabled,
  refreshPluginInstallState,
} from "../services/configActions";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSettingsStore } from "../stores/settingsStore";
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
    roborevEnabled: true,
    // NOT part of "all on": Builder Index and 1Password are the two tools that ship off, and
    // seeding either on here would hide a regression that flipped its default.
    builderIndexEnabled: false,
    builderIndexModalOpen: false,
    onepasswordEnabled: false,
    onepasswordVaultId: null,
    superpowersEnabled: true,
    frontendDesignEnabled: true,
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
    roborevEnabled: true,
    superpowersEnabled: true,
    frontendDesignEnabled: true,
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
    roborevEnabled: true,
    superpowersEnabled: true,
    frontendDesignEnabled: true,
  });
}

beforeEach(seedAllOn);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ToolsPane", () => {
  it("renders both groups, with switches on toggle rows and none on showcase rows", () => {
    render(<ToolsPane />);
    expect(screen.getByText("Your tools")).toBeTruthy();
    expect(screen.getByText("Built into Sparkle")).toBeTruthy();

    // Exactly the ten toggleable tools carry a switch. Superpowers is one of them now: it used
    // to be an info-only showcase row, and is a real [plugins] toggle since the plugin pre-enable
    // work — a stale showcase copy would claim Sparkle ships something the user can't turn off.
    expect(screen.getAllByRole("switch")).toHaveLength(10);
    for (const name of [
      "Deepgram voice",
      "Guardrails",
      "Roborev",
      "Builder Index",
      "Superpowers",
      "Frontend design",
      "1Password env backup",
      "Beads",
      "GitHub import",
      "Usage analytics",
    ]) {
      expect(screen.getByRole("switch", { name })).toBeTruthy();
    }

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
    useSettingsStore.setState({ superpowersEnabled: true, frontendDesignEnabled: false });
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
    // every existing worktree exactly as it was. Both rows must say so — otherwise the switch
    // reads as broken for every agent already on screen.
    expect(screen.getAllByText("Applies to agents created from now on.")).toHaveLength(2);
  });

  it("reports the installer's progress and failures on the plugin row", () => {
    // Turning a plugin on shells out to `claude plugin install`, which can take a while or fail
    // (offline, no claude, marketplace outage). That half is invisible to the user unless the row
    // says so — otherwise the switch reads ON while agents never see the plugin.
    useSettingsStore.setState({
      pluginInstallState: { superpowers: "installing", frontendDesign: "Sparkle couldn't install" },
    });
    render(<ToolsPane />);
    expect(screen.getByText("Installing…")).toBeTruthy();
    expect(screen.getByText("Sparkle couldn't install")).toBeTruthy();
    // The scope note is displaced while there's something more urgent to say, and only then.
    expect(screen.queryByText("Applies to agents created from now on.")).toBeNull();
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
