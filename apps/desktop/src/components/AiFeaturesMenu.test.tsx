// @vitest-environment jsdom
//
// Interaction tests for the "Use AI Features" menu: the All|Some|Off master is derived from the
// four feature checkboxes, All/Off bulk-set, and "Some" is status-only (not clickable).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiFeaturesMenu } from "./AiFeaturesMenu";
import { useSettingsStore, aiFeatureMode } from "../stores/settingsStore";

beforeEach(() => {
  useSettingsStore.getState().setAllAiFeatures(true);
});
afterEach(() => cleanup());

const mode = () => aiFeatureMode(useSettingsStore.getState());

// The four AI-feature checkboxes, addressed by label.
const AI_LABELS = [
  "Auto-rename workers based on the work they're doing",
  "Use AI-enhanced voice dictation for much better accuracy",
  "Enable the AI Think agent (chat with Chief)",
  "Use AI-enhanced composer",
];
const aiBoxes = () => AI_LABELS.map((l) => screen.getByRole("checkbox", { name: l }));

describe("AiFeaturesMenu", () => {
  it("starts with all features on and the master on 'All'", () => {
    render(<AiFeaturesMenu />);
    expect(mode()).toBe("all");
    // The four AI-feature checkboxes are all checked.
    const boxes = aiBoxes();
    expect(boxes).toHaveLength(4);
    expect(boxes.every((b) => b.getAttribute("aria-checked") === "true")).toBe(true);
    expect(screen.getByText("All").getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking Off unchecks everything; clicking All re-checks everything", () => {
    render(<AiFeaturesMenu />);
    fireEvent.click(screen.getByText("Off"));
    expect(mode()).toBe("off");
    expect(aiBoxes().every((b) => b.getAttribute("aria-checked") === "false")).toBe(true);
    fireEvent.click(screen.getByText("All"));
    expect(mode()).toBe("all");
    expect(aiBoxes().every((b) => b.getAttribute("aria-checked") === "true")).toBe(true);
  });

  it("no longer renders the 'Automatically apply updates' toggle (it moved to Advanced)", () => {
    render(<AiFeaturesMenu />);
    expect(screen.queryByRole("checkbox", { name: "Automatically apply updates" })).toBeNull();
  });

  it("unchecking one feature drops the master to 'Some'", () => {
    render(<AiFeaturesMenu />);
    const composer = screen.getByRole("checkbox", { name: "Use AI-enhanced composer" });
    fireEvent.click(composer);
    expect(useSettingsStore.getState().aiComposer).toBe(false);
    expect(mode()).toBe("some");
    // "Some" is non-interactive: it marks the derived state with aria-current (not aria-pressed).
    expect(screen.getByText("Some").getAttribute("aria-current")).toBe("true");
  });

  it("'Some' is status-only — clicking it does not change the flags", () => {
    render(<AiFeaturesMenu />);
    // Put it in a mixed state first so "Some" is showing.
    fireEvent.click(screen.getByRole("checkbox", { name: /Enable the AI Think agent/ }));
    const before = { ...useSettingsStore.getState() };
    fireEvent.click(screen.getByText("Some"));
    const after = useSettingsStore.getState();
    expect([after.aiAutoRename, after.cloudDictation, after.aiBrainstorm, after.aiComposer]).toEqual([
      before.aiAutoRename,
      before.cloudDictation,
      before.aiBrainstorm,
      before.aiComposer,
    ]);
  });

  it("toggling the voice checkbox maps to the cloudDictation flag the dictation code reads", () => {
    render(<AiFeaturesMenu />);
    fireEvent.click(screen.getByRole("checkbox", { name: /AI-enhanced voice dictation/ }));
    expect(useSettingsStore.getState().cloudDictation).toBe(false);
  });

  describe("auto-approve scope sub-choice", () => {
    const exceptBtn = () => screen.queryByRole("button", { name: "Everything except commands" });
    const fullBtn = () => screen.queryByRole("button", { name: "Everything, including commands" });

    it("is shown only while the Auto-answer checkbox is checked", () => {
      useSettingsStore.setState({ aiAutoApprove: true, approvals: {} });
      render(<AiFeaturesMenu />);
      expect(exceptBtn()).not.toBeNull();
      expect(fullBtn()).not.toBeNull();
      // Uncheck the master auto-answer toggle → the nested scope disappears.
      fireEvent.click(
        screen.getByRole("checkbox", { name: /Auto-answer Claude Code permission prompts/ }),
      );
      expect(useSettingsStore.getState().aiAutoApprove).toBe(false);
      expect(exceptBtn()).toBeNull();
      expect(fullBtn()).toBeNull();
    });

    it("'Everything, including commands' sets every category to always and highlights", () => {
      useSettingsStore.setState({ aiAutoApprove: true, approvals: {} });
      render(<AiFeaturesMenu />);
      fireEvent.click(fullBtn()!);
      const map = useSettingsStore.getState().approvals;
      expect(map.bash).toBe("always");
      expect(map.edit).toBe("always");
      expect(fullBtn()!.getAttribute("aria-pressed")).toBe("true");
      expect(exceptBtn()!.getAttribute("aria-pressed")).toBe("false");
    });

    it("'Everything except commands' auto-approves the rest but leaves bash asking", () => {
      useSettingsStore.setState({ aiAutoApprove: true, approvals: {} });
      render(<AiFeaturesMenu />);
      fireEvent.click(exceptBtn()!);
      const map = useSettingsStore.getState().approvals;
      expect(map.bash).toBeUndefined();
      expect(map.edit).toBe("always");
      expect(exceptBtn()!.getAttribute("aria-pressed")).toBe("true");
      expect(fullBtn()!.getAttribute("aria-pressed")).toBe("false");
    });
  });
});
