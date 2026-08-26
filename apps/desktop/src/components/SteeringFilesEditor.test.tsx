// @vitest-environment jsdom
//
// The steering-files pane. Each of these asserts a SIDE EFFECT the pane exists to produce, not that
// a handler is wired:
//   • the LAYER that supplied each file is painted, per file, with the real label Rust uses;
//   • an UNREADABLE layer renders as its own alerting state and NEVER as an empty file — collapsing
//     the two in the UI would undo the fail-closed rule the backend is built around;
//   • an edit is written to the layer the user PICKED, with the exact command args;
//   • seeding templates re-reads, so the new file appears without a manual refresh.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/steeringFiles", async () => {
  const actual =
    await vi.importActual<typeof import("../services/steeringFiles")>("../services/steeringFiles");
  return {
    // `layerLabel` is imported from the REAL module on purpose: the badge text is the contract with
    // Rust's `SteeringLayer::label`, and a mocked label would make the badge assertions vacuous.
    layerLabel: actual.layerLabel,
    fetchSteeringStatus: vi.fn(),
    writeSteeringFile: vi.fn(),
    seedSteeringTemplates: vi.fn(),
  };
});

import { SteeringFilesEditor } from "./SteeringFilesEditor";
import {
  fetchSteeringStatus,
  seedSteeringTemplates,
  writeSteeringFile,
  type SteeringFile,
  type SteeringStatus,
} from "../services/steeringFiles";

const fetchMock = vi.mocked(fetchSteeringStatus);
const writeMock = vi.mocked(writeSteeringFile);
const seedMock = vi.mocked(seedSteeringTemplates);

function file(over: Partial<SteeringFile> = {}): SteeringFile {
  return {
    name: "architecture.md",
    layer: "project",
    path: "/repo/.sparkle/steering/architecture.md",
    content: "# Architecture",
    error: null,
    ...over,
  };
}

function status(files: SteeringFile[], enabled = true): SteeringStatus {
  return {
    enabled,
    files,
    globalDir: "/app-data/steering",
    projectDir: "/repo/.sparkle/steering",
    localDir: "/repo/.sparkle/steering.local",
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  writeMock.mockReset();
  seedMock.mockReset();
});

afterEach(() => cleanup());

describe("the layer is painted, per file", () => {
  it("names a different layer for each file rather than one for the pane", async () => {
    fetchMock.mockResolvedValue(
      status([
        file(),
        file({
          name: "standards.md",
          layer: "local",
          path: "/repo/.sparkle/steering.local/standards.md",
          content: "RULES",
        }),
      ]),
    );
    render(<SteeringFilesEditor root="/repo" />);

    await waitFor(() =>
      expect(screen.getByTestId("steering-layer-architecture.md").textContent).toContain("project"),
    );
    // Resolution is per FILE, so a pane-wide badge would be wrong here — assert BOTH rows.
    expect(screen.getByTestId("steering-layer-standards.md").textContent).toContain("local override");
    expect(fetchMock).toHaveBeenCalledWith("/repo");
  });

  it("says 'not set' for a file no layer supplied", async () => {
    fetchMock.mockResolvedValue(
      status([file({ name: "standards.md", layer: null, path: null, content: null })]),
    );
    render(<SteeringFilesEditor root="/repo" />);
    await waitFor(() =>
      expect(screen.getByTestId("steering-layer-standards.md").textContent).toContain("not set"),
    );
  });
});

describe("an unreadable layer is its own state, never an empty file", () => {
  it("alerts with the reason instead of showing a reassuring blank box", async () => {
    fetchMock.mockResolvedValue(
      status([
        file({
          name: "standards.md",
          layer: null,
          path: "/repo/.sparkle/steering/standards.md",
          content: null,
          error: "could not read the project steering file at /repo/.sparkle/steering/standards.md",
        }),
      ]),
    );
    render(<SteeringFilesEditor root="/repo" />);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not read"));
    // THE DISTINCTION: an absent file paints no alert at all, so this assertion would pass for both
    // states if it only checked the textarea. Pin the alert AND the badge that is not "project".
    expect(screen.getByTestId("steering-layer-standards.md").textContent).toContain("not set");
  });

  it("paints no alert for a file that is merely absent", async () => {
    fetchMock.mockResolvedValue(
      status([file({ name: "standards.md", layer: null, path: null, content: null })]),
    );
    render(<SteeringFilesEditor root="/repo" />);
    await waitFor(() => expect(screen.getByTestId("steering-files-editor")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("editing", () => {
  it("writes the edit to the layer the user picked, not to the one it came from", async () => {
    fetchMock.mockResolvedValue(status([file()]));
    writeMock.mockResolvedValue("/repo/.sparkle/steering.local/architecture.md");
    render(<SteeringFilesEditor root="/repo" />);

    const box = await screen.findByLabelText("architecture.md contents");
    fireEvent.change(box, { target: { value: "# Architecture\nservices/ owns the API." } });
    fireEvent.change(screen.getByLabelText("Layer to save architecture.md to"), {
      target: { value: "local" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      // THE SIDE EFFECT, with its exact args: the edited text, and the CHOSEN layer.
      expect(writeMock).toHaveBeenCalledWith(
        "/repo",
        "architecture.md",
        "# Architecture\nservices/ owns the API.",
        "local",
      ),
    );
    // …and the resolved view is re-read, so the badge cannot go on claiming the old layer.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("defaults the destination to the layer that supplied the text", async () => {
    fetchMock.mockResolvedValue(
      status([
        file({
          name: "standards.md",
          layer: "local",
          path: "/repo/.sparkle/steering.local/standards.md",
          content: "RULES",
        }),
      ]),
    );
    writeMock.mockResolvedValue("/repo/.sparkle/steering.local/standards.md");
    render(<SteeringFilesEditor root="/repo" />);

    const btn = await screen.findByRole("button", { name: /save/i });
    fireEvent.click(btn);
    // No layer was chosen, so the obvious gesture must write BACK to the file being looked at
    // rather than shadowing it with a project-layer copy nothing reads.
    await waitFor(() =>
      expect(writeMock).toHaveBeenCalledWith("/repo", "standards.md", "RULES", "local"),
    );
  });

  it("reports a failed write and does not claim it saved", async () => {
    fetchMock.mockResolvedValue(status([file()]));
    writeMock.mockRejectedValue("could not write /repo/.sparkle/steering/architecture.md");
    render(<SteeringFilesEditor root="/repo" />);

    fireEvent.click(await screen.findByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not write"));
    expect(screen.queryByText(/^Saved to/)).toBeNull();
  });
});

describe("seeding templates", () => {
  it("re-reads afterwards so the created file appears without a manual refresh", async () => {
    fetchMock
      .mockResolvedValueOnce(status([file({ name: "standards.md", layer: null, path: null, content: null })]))
      .mockResolvedValue(
        status([
          file({
            name: "standards.md",
            layer: "project",
            path: "/repo/.sparkle/steering/standards.md",
            content: "# Standards",
          }),
        ]),
      );
    seedMock.mockResolvedValue({
      created: ["standards.md"],
      skippedExisting: [],
      skippedEmpty: [],
      errors: [],
    });
    render(<SteeringFilesEditor root="/repo" />);

    await waitFor(() =>
      expect(screen.getByTestId("steering-layer-standards.md").textContent).toContain("not set"),
    );
    fireEvent.click(screen.getByRole("button", { name: /create missing files/i }));

    await waitFor(() => expect(seedMock).toHaveBeenCalledWith("/repo"));
    // THE SIDE EFFECT: the pane now shows the seeded file's layer, not the stale "not set".
    await waitFor(() =>
      expect(screen.getByTestId("steering-layer-standards.md").textContent).toContain("project"),
    );
    expect(screen.getByTestId("steering-seed-note").textContent).toContain("Created standards.md.");
  });
});

describe("the disabled state", () => {
  it("says steering is off and still lets the files be edited", async () => {
    fetchMock.mockResolvedValue(status([file()], false));
    render(<SteeringFilesEditor root="/repo" />);

    await waitFor(() =>
      expect(screen.getByTestId("steering-disabled").textContent).toContain("Steering is off"),
    );
    // Editing must stay available: writing the files is how a user gets ready to turn it on.
    expect(screen.getByLabelText("architecture.md contents")).toBeTruthy();
  });

  it("says nothing about being off when it is on", async () => {
    fetchMock.mockResolvedValue(status([file()], true));
    render(<SteeringFilesEditor root="/repo" />);
    await waitFor(() => expect(screen.getByTestId("steering-files-editor")).toBeTruthy());
    expect(screen.queryByTestId("steering-disabled")).toBeNull();
  });
});
