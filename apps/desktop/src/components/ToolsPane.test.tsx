// @vitest-environment jsdom
//
// The Tools pane of the ⋯ settings dialog. Covers: both groups render (toggle rows have a switch,
// showcase rows do NOT); toggling a row routes to the right configActions writer (setAiFeature for
// the AI tools, setToolEnabled for the [tools] flags); the AI rows lock + show a hint when the AI
// master is Off; Learn-more opens the provider URL. configActions + plugin-opener are mocked so no
// IPC fires; the settingsStore is the real one, driven per test via setState.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/configActions", () => ({
  setAiFeature: vi.fn().mockResolvedValue(undefined),
  setToolEnabled: vi.fn().mockResolvedValue(undefined),
  setRoborevEnabled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { setAiFeature, setToolEnabled, setRoborevEnabled } from "../services/configActions";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSettingsStore } from "../stores/settingsStore";
import { ToolsPane } from "./ToolsPane";

/** Seed the store to a known baseline: every AI flag + every tool ON (aiFeatureMode = "all"). */
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
    analyticsEnabled: true,
    beadsEnabled: true,
    githubEnabled: true,
    guardrailsEnabled: true,
    roborevEnabled: true,
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

    // Exactly the six toggleable tools carry a switch (Roborev is now a real toggle, not showcase).
    expect(screen.getAllByRole("switch")).toHaveLength(6);
    for (const name of [
      "Deepgram voice",
      "Guardrails",
      "Roborev",
      "Beads",
      "GitHub import",
      "Usage analytics",
    ]) {
      expect(screen.getByRole("switch", { name })).toBeTruthy();
    }

    // Showcase tools are info-only: present by name, badge shown, but NO switch.
    for (const name of ["Claude Code", "Superpowers"]) {
      expect(screen.getByText(name)).toBeTruthy();
      expect(screen.queryByRole("switch", { name })).toBeNull();
    }
    expect(screen.getByText("Core")).toBeTruthy();
    // Only Superpowers remains a "Built-in" showcase row now.
    expect(screen.getAllByText("Built-in")).toHaveLength(1);
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
    // A showcase row's link too (Superpowers → GitHub).
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

  it("filters its rows by the query prop (pane-row search)", () => {
    render(<ToolsPane query="github" />);
    // Only the matching tool survives; unrelated rows and the empty group vanish.
    expect(screen.getByRole("switch", { name: "GitHub import" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Beads" })).toBeNull();
    expect(screen.queryByText("Built into Sparkle")).toBeNull();
  });
});
