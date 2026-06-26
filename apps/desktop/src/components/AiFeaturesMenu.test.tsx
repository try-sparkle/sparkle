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

describe("AiFeaturesMenu", () => {
  it("starts with all features on and the master on 'All'", () => {
    render(<AiFeaturesMenu />);
    expect(mode()).toBe("all");
    // The four checkboxes are all checked.
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    expect(boxes.every((b) => b.getAttribute("aria-checked") === "true")).toBe(true);
    expect(screen.getByText("All").getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking Off unchecks everything; clicking All re-checks everything", () => {
    render(<AiFeaturesMenu />);
    fireEvent.click(screen.getByText("Off"));
    expect(mode()).toBe("off");
    expect(screen.getAllByRole("checkbox").every((b) => b.getAttribute("aria-checked") === "false")).toBe(true);
    fireEvent.click(screen.getByText("All"));
    expect(mode()).toBe("all");
    expect(screen.getAllByRole("checkbox").every((b) => b.getAttribute("aria-checked") === "true")).toBe(true);
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
});
