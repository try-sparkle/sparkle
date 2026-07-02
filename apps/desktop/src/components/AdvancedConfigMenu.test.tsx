// @vitest-environment jsdom
//
// Tests for the Advanced pane's "Automatically apply updates" toggle (moved here from the AI
// features menu — it's an app toggle, not an AI feature). The config.toml editor itself talks to
// Tauri, so the config service and the opener plugin are mocked out.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/config", () => ({
  configFilePaths: vi.fn().mockResolvedValue({ global: "/tmp/config.toml" }),
  readConfigText: vi.fn().mockResolvedValue("# config"),
  resetConfig: vi.fn().mockResolvedValue(undefined),
  writeConfigText: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

import { AdvancedConfigMenu } from "./AdvancedConfigMenu";
import { useSettingsStore } from "../stores/settingsStore";

beforeEach(() => {
  useSettingsStore.getState().setAutoApplyUpdates(true);
});
afterEach(() => cleanup());

describe("AdvancedConfigMenu", () => {
  it("renders the 'Automatically apply updates' toggle and flips only autoApplyUpdates", () => {
    render(<AdvancedConfigMenu />);
    const box = screen.getByRole("checkbox", { name: "Automatically apply updates" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    const before = { ...useSettingsStore.getState() };
    fireEvent.click(box);
    const after = useSettingsStore.getState();
    expect(after.autoApplyUpdates).toBe(false);
    // All five AI feature flags are untouched by the updates toggle.
    const aiFlags = (s: typeof after) => ({
      aiAutoRename: s.aiAutoRename,
      cloudDictation: s.cloudDictation,
      aiBrainstorm: s.aiBrainstorm,
      aiComposer: s.aiComposer,
      aiSuggestedActions: s.aiSuggestedActions,
    });
    expect(aiFlags(after)).toEqual(aiFlags(before));
  });

  it("reflects the store value when auto-apply is off", () => {
    useSettingsStore.getState().setAutoApplyUpdates(false);
    render(<AdvancedConfigMenu />);
    const box = screen.getByRole("checkbox", { name: "Automatically apply updates" });
    expect(box.getAttribute("aria-checked")).toBe("false");
  });
});
