// apps/desktop/src/services/beadsCommands.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  beadsQuery,
  beadsDetail,
  beadsCreate,
  beadsUpdate,
  beadsClose,
  beadsComment,
  toBeadsError,
  isBeadsError,
  isNoWorkspace,
  isBdMissing,
  describeOmissions,
  type BeadPage,
  type BeadSummary,
  type BeadsError,
} from "./beadsCommands";

afterEach(() => {
  invokeMock.mockReset();
});

function summary(partial: Partial<BeadSummary> & { id: string }): BeadSummary {
  return {
    title: "",
    status: "open",
    priority: null,
    issueType: null,
    assignee: null,
    parent: null,
    labels: [],
    description: "",
    descriptionTruncated: false,
    dependencyCount: 0,
    dependentCount: 0,
    commentCount: 0,
    createdAt: null,
    updatedAt: null,
    closedAt: null,
    ...partial,
  };
}

function page(partial: Partial<BeadPage> = {}): BeadPage {
  return { beads: [], total: 0, omitted: 0, omittedIds: [], limit: 100, ...partial };
}

// ── Queries return parsed, typed results ────────────────────────────────────────────────────

describe("beadsQuery", () => {
  it("returns the typed page the Rust command produced", async () => {
    // The exact camelCase wire shape beads_cmd.rs serializes (pinned by a Rust test).
    const wire: BeadPage = page({
      beads: [
        summary({
          id: "sparkle-8jfx",
          title: "[bug] spawn_worker re-dispatches the previous task",
          status: "open",
          priority: 0,
          issueType: "bug",
          assignee: "drodio@gmail.com",
          labels: ["orchestrator", "p0"],
          description: "Observed live while orchestrating the epic",
          dependencyCount: 2,
          commentCount: 1,
        }),
      ],
      total: 1,
    });
    invokeMock.mockResolvedValue(wire);

    const result = await beadsQuery("/repo", { status: "open", priority: "0" });

    expect(invokeMock).toHaveBeenCalledWith("beads_query", {
      projectPath: "/repo",
      query: { status: "open", priority: "0" },
    });
    expect(result.beads[0]?.id).toBe("sparkle-8jfx");
    expect(result.beads[0]?.priority).toBe(0);
    expect(result.beads[0]?.labels).toEqual(["orchestrator", "p0"]);
    expect(result.total).toBe(1);
  });

  it("defaults to an empty query so `{}` is a valid call", async () => {
    invokeMock.mockResolvedValue(page());
    await beadsQuery("/repo");
    expect(invokeMock).toHaveBeenCalledWith("beads_query", { projectPath: "/repo", query: {} });
  });

  it("passes every filter through under its camelCase key", async () => {
    invokeMock.mockResolvedValue(page());
    await beadsQuery("/repo", {
      status: "open,in_progress",
      priority: "1",
      parent: "sparkle-4562",
      assignee: "drodio",
      issueType: "bug",
      label: "p0",
      titleContains: "concierge",
      ready: true,
      blocked: false,
      includeClosed: true,
      limit: 25,
    });
    const args = invokeMock.mock.calls[0]?.[1] as { query: Record<string, unknown> };
    expect(args.query).toMatchObject({
      issueType: "bug",
      titleContains: "concierge",
      includeClosed: true,
      ready: true,
      limit: 25,
    });
  });
});

// ── The output cap is visible to the caller ─────────────────────────────────────────────────

describe("the output cap", () => {
  it("reports an exact omitted count alongside a capped page", async () => {
    // The motivating case: a query against 800+ beads.
    invokeMock.mockResolvedValue(
      page({
        beads: Array.from({ length: 100 }, (_, i) => summary({ id: `b-${i}` })),
        total: 825,
        omitted: 725,
        omittedIds: Array.from({ length: 20 }, (_, i) => `b-${100 + i}`),
        limit: 100,
      }),
    );

    const result = await beadsQuery("/repo");

    expect(result.beads).toHaveLength(100);
    expect(result.total).toBe(825);
    expect(result.omitted).toBe(725);
    // A capped SAMPLE of ids, while the count above stayed exact.
    expect(result.omittedIds).toHaveLength(20);
  });

  it("describes the omission in words so a caller cannot silently under-report", async () => {
    const msg = describeOmissions(
      page({
        beads: [summary({ id: "b-0" })],
        total: 825,
        omitted: 824,
        omittedIds: ["b-1", "b-2", "b-3", "b-4", "b-5", "b-6"],
      }),
    );
    expect(msg).toContain("Showing 1 of 825");
    expect(msg).toContain("824 omitted");
    // The sample in the prose is itself capped, so the sentence stays short.
    expect(msg).toContain("b-1, b-2, b-3, b-4, b-5");
    expect(msg).not.toContain("b-6");
    expect(msg).toContain("limit");
  });

  it("says nothing when the page is complete", () => {
    expect(describeOmissions(page({ beads: [summary({ id: "b-0" })], total: 1 }))).toBeNull();
  });

  it("marks an excerpted description so it is not mistaken for the full text", async () => {
    invokeMock.mockResolvedValue(
      page({
        beads: [summary({ id: "b-1", description: "x".repeat(280), descriptionTruncated: true })],
        total: 1,
      }),
    );
    const result = await beadsQuery("/repo");
    expect(result.beads[0]?.descriptionTruncated).toBe(true);
  });
});

// ── Typed errors, never a raw throw ─────────────────────────────────────────────────────────

describe("typed errors", () => {
  it("rejects with the structured error the Rust side produced", async () => {
    const wire: BeadsError = {
      kind: "binaryNotFound",
      message: "bd not found — install beads",
      exitCode: null,
    };
    invokeMock.mockRejectedValue(wire);

    // Tauri rejects with the VALUE, not an Error, so assert on the object.
    await expect(beadsQuery("/repo")).rejects.toMatchObject({ kind: "binaryNotFound" });
    await expect(beadsQuery("/repo")).rejects.toMatchObject({
      message: "bd not found — install beads",
    });
  });

  it("coerces a non-structured rejection into a typed error instead of leaking it", async () => {
    // A failure that never reached Rust (IPC down, command unregistered) rejects with a string
    // or an Error. A caller must still be able to read `.kind`.
    invokeMock.mockRejectedValue(new Error("ipc bridge unavailable"));
    const err = await beadsQuery("/repo").catch((e) => e);
    expect(isBeadsError(err)).toBe(true);
    expect(err.kind).toBe("bdFailed");
    expect(err.message).toBe("ipc bridge unavailable");
    expect(err.exitCode).toBeNull();
  });

  it("coerces a bare string rejection", async () => {
    invokeMock.mockRejectedValue("command not found");
    const err = await beadsDetail("/repo", "b-1").catch((e) => e);
    expect(err.kind).toBe("bdFailed");
    expect(err.message).toBe("command not found");
  });

  it("never produces an empty message, even from an unhelpful rejection", () => {
    expect(toBeadsError(undefined).message).toBeTruthy();
    expect(toBeadsError(null).message).toBeTruthy();
    expect(toBeadsError("").message).toBe("unknown beads failure");
  });

  it("preserves an exit code when bd reported one", () => {
    const e = toBeadsError({ kind: "bdFailed", message: "boom", exitCode: 1 });
    expect(e.exitCode).toBe(1);
  });

  it("recognizes every kind the Rust enum can emit", () => {
    for (const kind of [
      "binaryNotFound",
      "noWorkspace",
      "invalidInput",
      "bdFailed",
      "timeout",
      "badOutput",
    ]) {
      expect(isBeadsError({ kind, message: "", exitCode: null })).toBe(true);
    }
    expect(isBeadsError({ kind: "somethingElse" })).toBe(false);
    expect(isBeadsError("nope")).toBe(false);
    expect(isBeadsError(null)).toBe(false);
  });

  it("distinguishes a missing workspace from a missing binary — different remedies", () => {
    const noWorkspace = { kind: "noWorkspace", message: "no beads database found", exitCode: 1 };
    const noBinary = { kind: "binaryNotFound", message: "bd not found", exitCode: null };

    expect(isNoWorkspace(noWorkspace)).toBe(true);
    expect(isBdMissing(noWorkspace)).toBe(false);

    expect(isBdMissing(noBinary)).toBe(true);
    expect(isNoWorkspace(noBinary)).toBe(false);

    // An unrelated failure is neither, so a caller does not run `bd init` over a real error.
    expect(isNoWorkspace(new Error("disk full"))).toBe(false);
    expect(isBdMissing(new Error("disk full"))).toBe(false);
  });
});

// ── Detail ──────────────────────────────────────────────────────────────────────────────────

describe("beadsDetail", () => {
  it("returns the bead with its children and both link directions", async () => {
    invokeMock.mockResolvedValue({
      bead: summary({ id: "sparkle-4562", title: "EPIC: Concierge Mode", status: "in_progress" }),
      fullDescription: "the complete, uncut description",
      children: page({ beads: [summary({ id: "sparkle-4562.2" })], total: 1 }),
      dependencies: [{ id: "b-9", linkType: "blocks" }],
      dependents: [{ id: "b-2", linkType: "parent-child" }],
      linksTruncated: false,
    });

    const d = await beadsDetail("/repo", "sparkle-4562");

    expect(invokeMock).toHaveBeenCalledWith("beads_detail", {
      projectPath: "/repo",
      id: "sparkle-4562",
    });
    expect(d.bead.status).toBe("in_progress");
    // The uncut text lives here; `bead.description` stays an excerpt.
    expect(d.fullDescription).toBe("the complete, uncut description");
    expect(d.children.beads[0]?.id).toBe("sparkle-4562.2");
    expect(d.dependencies[0]?.id).toBe("b-9");
    expect(d.dependents[0]?.linkType).toBe("parent-child");
  });
});

// ── Mutations ───────────────────────────────────────────────────────────────────────────────

describe("mutations", () => {
  it("creates a bead and returns it", async () => {
    invokeMock.mockResolvedValue(summary({ id: "", title: "a new bead" }));
    const created = await beadsCreate("/repo", { title: "a new bead", issueType: "task" });
    expect(invokeMock).toHaveBeenCalledWith("beads_create", {
      projectPath: "/repo",
      bead: { title: "a new bead", issueType: "task" },
    });
    expect(created.id).toBe("");
  });

  it("sends only the patched fields", async () => {
    invokeMock.mockResolvedValue(null);
    await beadsUpdate("/repo", "b-1", { priority: "0" });
    expect(invokeMock).toHaveBeenCalledWith("beads_update", {
      projectPath: "/repo",
      id: "b-1",
      patch: { priority: "0" },
    });
  });

  it("closes with a reason", async () => {
    invokeMock.mockResolvedValue(null);
    await beadsClose("/repo", "b-1", "shipped in v0.49");
    expect(invokeMock).toHaveBeenCalledWith("beads_close", {
      projectPath: "/repo",
      id: "b-1",
      reason: "shipped in v0.49",
    });
  });

  it("adds a comment", async () => {
    invokeMock.mockResolvedValue(null);
    await beadsComment("/repo", "b-1", "blocked on the auth rewrite");
    expect(invokeMock).toHaveBeenCalledWith("beads_comment", {
      projectPath: "/repo",
      id: "b-1",
      text: "blocked on the auth rewrite",
    });
  });

  it("surfaces a rejected mutation as a typed error", async () => {
    invokeMock.mockRejectedValue({
      kind: "invalidInput",
      message: "patch is empty — set at least one of status, priority, assignee",
      exitCode: null,
    });
    const err = await beadsUpdate("/repo", "b-1", {}).catch((e) => e);
    expect(err.kind).toBe("invalidInput");
  });

  it("does not resolve a mutation that failed", async () => {
    invokeMock.mockRejectedValue({ kind: "bdFailed", message: "bd exited 1", exitCode: 1 });
    await expect(beadsClose("/repo", "b-1", "done")).rejects.toMatchObject({ exitCode: 1 });
  });
});
