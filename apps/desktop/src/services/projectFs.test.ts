// apps/desktop/src/services/projectFs.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { appendNote, createTask } from "./projectFs";

afterEach(() => {
  invokeMock.mockReset();
});

describe("projectFs", () => {
  it("appendNote forwards camelCase args to the append_note command", async () => {
    invokeMock.mockResolvedValue(undefined);
    await appendNote("/proj", "note body", "2026-06-24T00:00:00Z");
    expect(invokeMock).toHaveBeenCalledWith("append_note", {
      projectPath: "/proj",
      text: "note body",
      timestamp: "2026-06-24T00:00:00Z",
    });
  });

  it("createTask parses the bead id from bd --json stdout", async () => {
    invokeMock.mockResolvedValue('{"id":"tt-4qs","title":"Hello"}');
    const id = await createTask("/proj", "Hello", "body");
    expect(id).toBe("tt-4qs");
    expect(invokeMock).toHaveBeenCalledWith("create_bead", {
      projectPath: "/proj",
      title: "Hello",
      body: "body",
    });
  });

  it("createTask throws the bd error message when bd returns an error object", async () => {
    invokeMock.mockResolvedValue('{"error":"database not initialized","schema_version":1}');
    await expect(createTask("/proj", "Hello", "body")).rejects.toThrow("database not initialized");
  });

  it("createTask throws on non-JSON stdout (shell warning / garbled output)", async () => {
    invokeMock.mockResolvedValue("zsh: command not found: bd");
    await expect(createTask("/proj", "Hello", "body")).rejects.toThrow(
      "Unexpected bd output: zsh: command not found: bd"
    );
  });

  it("createTask throws when bd JSON has neither id nor error", async () => {
    invokeMock.mockResolvedValue('{"schema_version":1}');
    await expect(createTask("/proj", "Hello", "body")).rejects.toThrow("bd returned no id:");
  });
});
