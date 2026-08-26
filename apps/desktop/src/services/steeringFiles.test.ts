// Pins the JS↔Rust contract for the steering commands: the command NAMES, the camelCase arg keys,
// and the null-vs-undefined shape a Rust `Option<T>` actually arrives in.
//
// The contract is the whole risk here. Rust and TypeScript were written from one field list, and an
// all-or-nothing parser that rejects a payload leaves the feature inert FOR EVERYONE with nothing
// logged (AGENTS.md: `sparkle-16y6h`). A misspelled command name fails the same silent way — the
// invoke rejects, the caller's catch swallows it, and the editor renders an empty pane forever.
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  fetchSteeringPreflightBlock,
  fetchSteeringStatus,
  layerLabel,
  readSteeringFile,
  seedSteeringTemplates,
  writeSteeringFile,
  type SteeringStatus,
} from "./steeringFiles";

beforeEach(() => {
  invokeMock.mockReset();
});

/** The payload Rust actually emits: `Option<T>` as `null`, never an absent key. */
const STATUS: SteeringStatus = {
  enabled: true,
  files: [
    {
      name: "architecture.md",
      layer: "project",
      path: "/repo/.sparkle/steering/architecture.md",
      content: "# Architecture",
      error: null,
    },
    { name: "standards.md", layer: null, path: null, content: null, error: null },
  ],
  globalDir: "/app-data/steering",
  projectDir: "/repo/.sparkle/steering",
  localDir: "/repo/.sparkle/steering.local",
};

describe("the command contract", () => {
  it("asks steering_status for a root and hands the payload back unchanged", async () => {
    invokeMock.mockResolvedValue(STATUS);
    await expect(fetchSteeringStatus("/repo")).resolves.toEqual(STATUS);
    expect(invokeMock).toHaveBeenCalledWith("steering_status", { root: "/repo" });
  });

  it("names each file for steering_read", async () => {
    invokeMock.mockResolvedValue(STATUS.files[0]);
    await readSteeringFile("/repo", "architecture.md");
    expect(invokeMock).toHaveBeenCalledWith("steering_read", {
      root: "/repo",
      name: "architecture.md",
    });
  });

  it("sends the layer with every write, because the layer IS the destination", async () => {
    invokeMock.mockResolvedValue("/repo/.sparkle/steering.local/standards.md");
    const path = await writeSteeringFile("/repo", "standards.md", "RULES", "local");
    expect(invokeMock).toHaveBeenCalledWith("steering_write", {
      root: "/repo",
      name: "standards.md",
      content: "RULES",
      layer: "local",
    });
    expect(path).toBe("/repo/.sparkle/steering.local/standards.md");
  });

  it("seeds templates and reports what it actually wrote", async () => {
    invokeMock.mockResolvedValue({
      created: ["standards.md"],
      skippedExisting: ["architecture.md"],
      skippedEmpty: [],
      errors: [],
    });
    const report = await seedSteeringTemplates("/repo");
    expect(invokeMock).toHaveBeenCalledWith("steering_seed_templates", { root: "/repo" });
    expect(report.created).toEqual(["standards.md"]);
    expect(report.skippedExisting).toEqual(["architecture.md"]);
  });

  it("returns the pre-flight block verbatim, empty string included", async () => {
    invokeMock.mockResolvedValue("");
    // The empty string IS the "nothing to inject" answer — there is no separate flag, so a caller
    // that turned "" into a placeholder would inject text Rust decided not to send.
    await expect(fetchSteeringPreflightBlock("/repo")).resolves.toBe("");
    expect(invokeMock).toHaveBeenCalledWith("steering_preflight_block", { root: "/repo" });
  });

  it("propagates a rejection rather than inventing an empty result", async () => {
    invokeMock.mockRejectedValue("steering_status failed");
    await expect(fetchSteeringStatus("/repo")).rejects.toBe("steering_status failed");
  });
});

describe("layerLabel", () => {
  it("matches SteeringLayer::label in Rust, and says 'not set' for an absent layer", () => {
    expect(layerLabel("global")).toBe("global");
    expect(layerLabel("project")).toBe("project");
    expect(layerLabel("local")).toBe("local override");
    // Null, not undefined — the shape serde actually sends for a file no layer supplied.
    expect(layerLabel(null)).toBe("not set");
  });
});
