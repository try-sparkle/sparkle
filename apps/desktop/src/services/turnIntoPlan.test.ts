import { describe, it, expect, vi } from "vitest";
import { synthesizePrd } from "./prd";
import { generateTasks } from "./tasks";
import { turnIntoPlan } from "./turnIntoPlan";

describe("turnIntoPlan (composition)", () => {
  it("synthesizes a PRD, feeds it into generate, and returns the linkage", async () => {
    const synthesize = vi.fn(async () => ({
      path: "PRD/2026-06-27-mobile-app.md",
      filename: "2026-06-27-mobile-app.md",
      title: "Build the mobile app",
      content: "---\nepic: null\n---\n\n# Build the mobile app\n",
    }));
    const generate = vi.fn(async () => ({
      epicId: "epic-1",
      taskIds: ["epic-1.1", "epic-1.2"],
      updatedPrdContent: "updated",
    }));

    const res = await turnIntoPlan(
      { synthesize, generate },
      { pat: "pat_x", chiefProjectId: "chief", projectPath: "/repo", transcript: "we want a mobile app" },
    );

    expect(synthesize).toHaveBeenCalledWith({
      pat: "pat_x",
      chiefProjectId: "chief",
      projectPath: "/repo",
      transcript: "we want a mobile app",
    });
    // The PRD output threads straight into generate (filename/content/path).
    expect(generate).toHaveBeenCalledWith({
      projectPath: "/repo",
      prdFilename: "2026-06-27-mobile-app.md",
      prdContent: "---\nepic: null\n---\n\n# Build the mobile app\n",
      prdRelPath: "PRD/2026-06-27-mobile-app.md",
    });
    expect(res).toEqual({
      epicId: "epic-1",
      epicTitle: "Build the mobile app",
      taskIds: ["epic-1.1", "epic-1.2"],
      prdPath: "PRD/2026-06-27-mobile-app.md",
      prdFilename: "2026-06-27-mobile-app.md",
    });
  });

  it("does not create any beads if synthesis fails (nothing half-links)", async () => {
    const synthesize = vi.fn(async () => {
      throw new Error("chief unavailable");
    });
    const generate = vi.fn();
    await expect(
      turnIntoPlan(
        { synthesize, generate },
        { pat: "p", chiefProjectId: "c", projectPath: "/r", transcript: "x" },
      ),
    ).rejects.toThrow(/chief unavailable/);
    expect(generate).not.toHaveBeenCalled();
  });
});

// The success criterion, proven at the service layer: a Think conversation becomes an epic with
// parent-linked child beads. Uses the REAL synthesizePrd + REAL generateTasks (only the Chief and
// bead-creation backends are faked), so the whole Think→Plan chain is exercised, not just the seam.
describe("Think→Plan pipeline (integration: real synthesizePrd + real generateTasks)", () => {
  it("turns an interview transcript into an epic with parent-linked child beads", async () => {
    // --- PRD synthesis backends (fake Chief + write) ---
    const startChat = vi.fn(async () => ({ chat_id: "c1", message_id: "m1" }));
    const prdMarkdown = "# Build the mobile app\n\n## Problem\nUsers need a phone app.\n";
    const pollForResponse = vi.fn(async () => prdMarkdown);
    const synthWritePrd = vi.fn(async (_p: string, filename: string) => `PRD/${filename}`);
    const fixedNow = () => new Date("2026-06-27T12:00:00Z");

    // --- task generation backends (fake plan + bead creation) ---
    const plan = {
      epic: { title: "Build the mobile app", description: "Ship a mobile client." },
      tasks: [
        { title: "Scaffold the RN project", description: "create the app shell" },
        { title: "Auth screen", description: "login UI", dependsOn: [0] },
      ],
      decisions: ["Use React Native"],
    };
    // structuredJson is generic (<T>() => Promise<T>); return the fixed plan cast to T.
    const structuredJson = async <T>(): Promise<T> => plan as unknown as T;
    const created: Array<{ title: string; issueType: string; parent: string }> = [];
    let calls = 0;
    const createBeadFull = vi.fn(
      async (_p: string, title: string, _b: string, issueType: string, parent: string) => {
        created.push({ title, issueType, parent });
        calls += 1;
        return issueType === "epic" ? "epic-1" : `epic-1.${calls - 1}`;
      },
    );
    const depEdges: Array<[string, string]> = [];
    const beadDepAdd = vi.fn(async (_p: string, blocked: string, blocker: string) => {
      depEdges.push([blocked, blocker]);
    });
    const genWritePrd = vi.fn(async () => "PRD/written.md");

    const res = await turnIntoPlan(
      {
        synthesize: (a) =>
          synthesizePrd({ startChat, pollForResponse, writePrd: synthWritePrd, now: fixedNow }, a),
        generate: (a) =>
          generateTasks({ structuredJson, createBeadFull, beadDepAdd, writePrd: genWritePrd }, a),
      },
      { pat: "pat", chiefProjectId: "chief", projectPath: "/repo", transcript: "build me a mobile app" },
    );

    // 1. The transcript was synthesized into a PRD (title from the h1; deterministic filename).
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(res.epicTitle).toBe("Build the mobile app");
    expect(res.prdPath).toBe("PRD/2026-06-27-build-the-mobile-app.md");

    // 2. The epic was created first (no parent), then each child with the epic as parent.
    expect(created[0]).toEqual({ title: "Build the mobile app", issueType: "epic", parent: "" });
    expect(created.slice(1)).toEqual([
      { title: "Scaffold the RN project", issueType: "task", parent: "epic-1" },
      { title: "Auth screen", issueType: "task", parent: "epic-1" },
    ]);
    expect(res.epicId).toBe("epic-1");
    expect(res.taskIds).toEqual(["epic-1.1", "epic-1.2"]);

    // 3. The dependency (task 1 depends on task 0) was wired into the work graph.
    expect(depEdges).toEqual([["epic-1.2", "epic-1.1"]]);

    // 4. The result is exactly what the "Build It" step (sendToBuild) consumes: epicId + prdPath.
    //    (sendToBuild embedding those into the orchestrator seed is proven in sendToBuild.test.ts.)
    expect(res.epicId).toBeTruthy();
    expect(res.prdPath).toBeTruthy();
  });
});
