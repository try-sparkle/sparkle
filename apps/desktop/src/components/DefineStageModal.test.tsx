// @vitest-environment jsdom
//
// Unit 4 — the Define/Edit modal. These tests exercise the modal's flow against MOCKED services:
// getConfig (the existing definition), detectDelivery (the Delivery Detector), structuredJson
// (the Haiku call), and writeStageDef (the persist). No Tauri/`bd`/network is touched.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SparkleConfig } from "../services/config";
import type { StageDefinition } from "../services/stageDefs";
import type { DeliveryProposal } from "../services/deliveryDetector";

// ── Mocks ──────────────────────────────────────────────────────────────────────────────────
const getConfig = vi.fn();
vi.mock("../services/config", () => ({ getConfig: (...a: unknown[]) => getConfig(...a) }));

const detectDelivery = vi.fn();
vi.mock("../services/deliveryDetector", () => ({
  detectDelivery: (...a: unknown[]) => detectDelivery(...a),
}));

const structuredJson = vi.fn();
vi.mock("../services/anthropic", () => ({
  structuredJson: (...a: unknown[]) => structuredJson(...a),
}));

// Keep the real stageDefs helpers (readStageDef/isDefined) but stub the write wrapper so nothing
// hits Tauri. readStageDef reads the (fake) config we feed via getConfig.
const writeStageDef = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/stageDefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/stageDefs")>();
  return { ...actual, writeStageDef: (...a: unknown[]) => writeStageDef(...a) };
});

import { DefineStageModal } from "./DefineStageModal";

// An "undefined" config: both stage sections empty → readStageDef returns undefined.
function emptyConfig(): SparkleConfig {
  return {
    // Only the fields readStageDef touches matter; the rest are structurally required.
    workflow: {} as SparkleConfig["workflow"],
    workers: {} as SparkleConfig["workers"],
    ai: {} as SparkleConfig["ai"],
    freshness: {} as SparkleConfig["freshness"],
    capture: {} as SparkleConfig["capture"],
    done: { description: null, criteria: [] },
    delivered: {
      description: null,
      detected_method: null,
      confidence: null,
      confidence_note: null,
      learned: false,
      criteria: [],
    },
  };
}

function configWithDone(): SparkleConfig {
  const cfg = emptyConfig();
  cfg.done = {
    description: "Merged and reviewed.",
    criteria: [
      { text: "Merged into origin/main", kind: "auto", signal: "merged_to_main" },
      { text: "Reviewed by a teammate", kind: "manual", signal: null },
    ],
  };
  return cfg;
}

const noneProposal: DeliveryProposal = {
  method: "unknown",
  confidence: "none",
  note: "Couldn't map how this project ships to production — tell Sparkle, or tick Delivered manually.",
  criteria: [{ text: "Deployed to prod verified", kind: "manual" }],
};

afterEach(() => {
  cleanup();
  getConfig.mockReset();
  detectDelivery.mockReset();
  structuredJson.mockReset();
  writeStageDef.mockClear();
});

beforeEach(() => {
  getConfig.mockResolvedValue({ config: emptyConfig(), warnings: [] });
});

const baseProps = { projectName: "Demo", projectRoot: "/tmp/demo", onClose: () => {} };

describe("DefineStageModal — Done (undefined)", () => {
  it("(a) shows the default Yes/No and YES persists the Done default", async () => {
    render(<DefineStageModal stageKey="done" {...baseProps} />);
    // The smart-default prompt appears with Yes/No.
    await screen.findByText(/typically defined as merging into the remote main branch/i);
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();

    fireEvent.click(screen.getByText("Yes"));

    await waitFor(() =>
      expect(writeStageDef).toHaveBeenCalledWith("/tmp/demo", "done", {
        description: "Merged into the remote main branch.",
        criteria: [{ text: "Merged into origin/main", kind: "auto", signal: "merged_to_main" }],
      }),
    );
    // Confirmation + Close after a successful save.
    expect(await screen.findByText(/“Done” is set for Demo/i)).toBeTruthy();
    expect(screen.getByText("Close")).toBeTruthy();
  });

  it("(b) NO reveals the chat box", async () => {
    render(<DefineStageModal stageKey="done" {...baseProps} />);
    await screen.findByText(/typically defined as merging/i);
    fireEvent.click(screen.getByText("No"));
    // The chat prompt + a text input appear.
    expect(await screen.findByText(/How do you want to define/i)).toBeTruthy();
    expect(screen.getByLabelText(/Describe what “Done” means/i)).toBeTruthy();
  });
});

describe("DefineStageModal — Delivered", () => {
  it("(c) detector confidence 'none' shows the honest can't-detect message straight into chat", async () => {
    detectDelivery.mockResolvedValue(noneProposal);
    render(<DefineStageModal stageKey="delivered" {...baseProps} />);
    // Honest copy, and NO Yes/No — it drops straight into the chat.
    expect(
      await screen.findByText(/I couldn’t detect how Demo ships to production/i),
    ).toBeTruthy();
    expect(screen.queryByText("Yes")).toBeNull();
    expect(screen.getByLabelText(/Describe what “Delivered” means/i)).toBeTruthy();
    expect(detectDelivery).toHaveBeenCalledWith("/tmp/demo");
  });

  it("low-confidence detection flags the best guess and offers Yes/No → No reveals chat", async () => {
    const lowProposal: DeliveryProposal = {
      method: "ci_deploy",
      confidence: "low",
      note: "Found a Dockerfile but no deploy workflow.",
      criteria: [{ text: "Deployed to prod verified", kind: "manual" }],
    };
    detectDelivery.mockResolvedValue(lowProposal);
    render(<DefineStageModal stageKey="delivered" {...baseProps} />);
    // Best-guess copy, clearly flagged low-confidence, with Yes/No.
    expect(await screen.findByText(/best guess/i)).toBeTruthy();
    expect(screen.getByText(/low confidence/i)).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
    fireEvent.click(screen.getByText("No"));
    expect(await screen.findByLabelText(/Describe what “Delivered” means/i)).toBeTruthy();
  });

  it("reconciles a user-stated method with the detector: keeps detector confidence/note when they agree", async () => {
    const detector: DeliveryProposal = {
      method: "release_tag",
      confidence: "high",
      note: "Ships via a GitHub Release workflow.",
      criteria: [{ text: "Commit is in a cut release", kind: "auto", signal: "in_release" }],
    };
    detectDelivery.mockResolvedValue(detector); // used by both the intro and finalizeDelivered
    // Haiku returns the same method but an unsure confidence — reconciliation should lift it.
    structuredJson.mockResolvedValue({
      description: "Shipped via releases.",
      criteria: [{ text: "Commit is in a cut release", kind: "auto", signal: "in_release" }],
      detectedMethod: "release_tag",
      confidence: "none",
      confidenceNote: "unsure",
    } satisfies StageDefinition);

    render(<DefineStageModal stageKey="delivered" {...baseProps} />);
    await screen.findByText(/ships to production via/i);
    fireEvent.click(screen.getByText("No"));
    const input = await screen.findByLabelText(/Describe what “Delivered” means/i);
    fireEvent.change(input, { target: { value: "we cut a github release" } });
    fireEvent.click(screen.getByText("Send"));
    await screen.findByText("Shipped via releases.");
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(writeStageDef).toHaveBeenCalledWith("/tmp/demo", "delivered", {
        description: "Shipped via releases.",
        criteria: [{ text: "Commit is in a cut release", kind: "auto", signal: "in_release" }],
        detectedMethod: "release_tag",
        // detector agreed on the method → its confidence + note win, and learn resets.
        confidence: "high",
        confidenceNote: "Ships via a GitHub Release workflow.",
        learned: false,
      }),
    );
  });

  it("high-confidence detection offers the detected proposal and YES persists it", async () => {
    const proposal: DeliveryProposal = {
      method: "release_tag",
      confidence: "high",
      note: "Ships via a GitHub Release workflow.",
      criteria: [
        { text: "Commit is in a cut release", kind: "auto", signal: "in_release" },
        { text: "Deployed to prod verified", kind: "manual" },
      ],
    };
    detectDelivery.mockResolvedValue(proposal);
    render(<DefineStageModal stageKey="delivered" {...baseProps} />);
    await screen.findByText(/ships to production via/i);
    fireEvent.click(screen.getByText("Yes"));
    await waitFor(() =>
      expect(writeStageDef).toHaveBeenCalledWith("/tmp/demo", "delivered", {
        description: "Shipped to production.",
        criteria: proposal.criteria,
        detectedMethod: "release_tag",
        confidence: "high",
        confidenceNote: "Ships via a GitHub Release workflow.",
        learned: false,
      }),
    );
    expect(await screen.findByText(/Delivered will track your production ships/i)).toBeTruthy();
  });
});

describe("DefineStageModal — edit mode", () => {
  it("(d) prefills an existing definition and offers to edit the instructions", async () => {
    getConfig.mockResolvedValue({ config: configWithDone(), warnings: [] });
    render(<DefineStageModal stageKey="done" {...baseProps} />);
    // The current definition renders (description + both criteria).
    expect(await screen.findByText("Merged and reviewed.")).toBeTruthy();
    expect(screen.getByText("Reviewed by a teammate")).toBeTruthy();
    // Auto badge carries the signal; manual badge present.
    expect(screen.getByText(/auto · merged_to_main/)).toBeTruthy();
    expect(screen.getByText("manual")).toBeTruthy();
    // Edit affordance + Close, no Yes/No.
    expect(screen.getByText("Edit the instructions")).toBeTruthy();
    expect(screen.queryByText("Yes")).toBeNull();
    fireEvent.click(screen.getByText("Edit the instructions"));
    expect(await screen.findByLabelText(/Describe what “Done” means/i)).toBeTruthy();
  });
});

describe("DefineStageModal — chat → Haiku → save", () => {
  it("sends free text to Haiku, previews the parsed definition, and saves it", async () => {
    const parsed: StageDefinition = {
      description: "All checks pass and merged.",
      criteria: [{ text: "Merged into origin/main", kind: "auto", signal: "merged_to_main" }],
    };
    structuredJson.mockResolvedValue(parsed);
    render(<DefineStageModal stageKey="done" {...baseProps} />);
    await screen.findByText(/typically defined as merging/i);
    fireEvent.click(screen.getByText("No"));

    const input = await screen.findByLabelText(/Describe what “Done” means/i);
    fireEvent.change(input, { target: { value: "when it's merged and CI is green" } });
    fireEvent.click(screen.getByText("Send"));

    // Preview of the parsed definition appears.
    expect(await screen.findByText("All checks pass and merged.")).toBeTruthy();
    expect(structuredJson).toHaveBeenCalledTimes(1);

    // Save persists exactly what Haiku produced.
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(writeStageDef).toHaveBeenCalledWith("/tmp/demo", "done", parsed),
    );
    // The confirmation reflects the CUSTOM saved definition, not the default phrasing.
    expect(await screen.findByText(/“Done” is set for Demo — All checks pass and merged\./i)).toBeTruthy();
  });

  it("Retry re-attempts a failed save (persist-failure path)", async () => {
    writeStageDef.mockRejectedValueOnce(new Error("config.toml is read-only"));
    render(<DefineStageModal stageKey="done" {...baseProps} />);
    await screen.findByText(/typically defined as merging/i);
    fireEvent.click(screen.getByText("Yes"));
    // First save fails → banner + Retry, modal still open (no confirmation yet).
    expect(await screen.findByText(/read-only/i)).toBeTruthy();
    expect(screen.queryByText(/“Done” is set/i)).toBeNull();
    // Retry re-invokes the SAME persist (writeStageDef now resolves) → confirmation appears.
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText(/“Done” is set for Demo/i)).toBeTruthy();
    expect(writeStageDef).toHaveBeenCalledTimes(2);
  });

  it("keeps the modal open and shows a Retry on Haiku failure", async () => {
    structuredJson.mockRejectedValueOnce(new Error("Claude did not return valid JSON: …"));
    render(<DefineStageModal stageKey="done" {...baseProps} />);
    await screen.findByText(/typically defined as merging/i);
    fireEvent.click(screen.getByText("No"));
    const input = await screen.findByLabelText(/Describe what “Done” means/i);
    // A distinctive phrase so the duplicate-bubble assertion can't match an incidental node.
    const userText = "when the pull request lands on trunk";
    fireEvent.change(input, { target: { value: userText } });
    fireEvent.click(screen.getByText("Send"));
    // The user's message shows once; error surfaces with a Retry; modal still mounted.
    expect(screen.getAllByText(userText)).toHaveLength(1);
    expect(await screen.findByText(/valid JSON/i)).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
    expect(screen.getByLabelText(/Describe what “Done” means/i)).toBeTruthy();

    // Retry re-runs the turn WITHOUT duplicating the user's message bubble.
    structuredJson.mockResolvedValueOnce({
      description: "Merged and green.",
      criteria: [],
    } satisfies StageDefinition);
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("Merged and green.")).toBeTruthy();
    expect(screen.getAllByText(userText)).toHaveLength(1);
  });
});
