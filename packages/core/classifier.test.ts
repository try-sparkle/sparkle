import { describe, expect, it } from "vitest";
import { classifyLine, type SessionContext } from "./classifier";

const ctx: SessionContext = { sessionId: "s1", branch: "main" };

describe("classifyLine — dangerous rules (interrupt + require approval)", () => {
  it.each([
    "running: rm -rf /tmp/build",
    "git push origin main",
    "vercel deploy --prod",
    "deploying to production now",
    "stripe charge customer $50",
    "DROP TABLE users;",
    "writing .env.production secrets",
  ])("classifies %j as dangerous + approval_needed", (line) => {
    const ev = classifyLine(line, ctx);
    expect(ev).not.toBeNull();
    expect(ev!.risk_class).toBe("dangerous");
    expect(ev!.event_type).toBe("approval_needed");
    // The raw line is always preserved for audit/retraining.
    expect(ev!.payload.raw).toBe(line);
  });
});

describe("classifyLine — caution rules (queue for next app open)", () => {
  it.each([
    "git push origin feature/x", // push (not to main) → caution, not dangerous
    "deploy to staging",
    "ALTER TABLE orders ADD COLUMN sku text",
    "npm publish",
    "kubectl apply -f deploy.yaml",
  ])("classifies %j as caution", (line) => {
    const ev = classifyLine(line, ctx);
    expect(ev).not.toBeNull();
    expect(ev!.risk_class).toBe("caution");
    expect(ev!.event_type).toBe("approval_needed");
  });

  it("ranks dangerous above caution when both could match (push to main)", () => {
    // 'push.*main' is dangerous and 'git push' is caution; dangerous must win.
    const ev = classifyLine("git push origin main", ctx);
    expect(ev!.risk_class).toBe("dangerous");
  });

  it("ranks caution above safe when both could match (npm publish vs test rule)", () => {
    // SAFE has /npm test|jest|vitest/ but CAUTION has /npm publish/ — caution wins.
    const ev = classifyLine("npm publish --access public", ctx);
    expect(ev!.risk_class).toBe("caution");
  });
});

describe("classifyLine — safe rules (auto-approve, log silently)", () => {
  it.each([
    "mkdir -p src/components",
    "pnpm add zustand",
    "running vitest run",
    "eslint --fix src",
    "git commit -m 'wip'", // commit is safe; push is caution
    "Reading file risk.ts",
  ])("classifies %j as safe", (line) => {
    const ev = classifyLine(line, ctx);
    expect(ev).not.toBeNull();
    expect(ev!.risk_class).toBe("safe");
    expect(ev!.event_type).toBe("file_write");
  });
});

describe("classifyLine — task markers (null risk, not approval gated)", () => {
  it("emits task_start for a 'Task:' line", () => {
    const ev = classifyLine("Task: build the login form", ctx);
    expect(ev).toEqual({
      event_type: "task_start",
      risk_class: null,
      description: "Task: build the login form",
      payload: {},
    });
  });

  it.each(["Complete: login form", "Done: shipped it"])(
    "emits task_complete for %j",
    (line) => {
      const ev = classifyLine(line, ctx);
      expect(ev!.event_type).toBe("task_complete");
      expect(ev!.risk_class).toBeNull();
    },
  );
});

describe("classifyLine — discard behavior", () => {
  it("returns null for an empty line", () => {
    expect(classifyLine("", ctx)).toBeNull();
    expect(classifyLine("   \t  ", ctx)).toBeNull();
  });

  it("returns null for an unremarkable line that matches no rule", () => {
    expect(classifyLine("just some ordinary log chatter", ctx)).toBeNull();
  });
});

describe("classifyLine — description normalization", () => {
  it("collapses whitespace and truncates to 200 chars", () => {
    const long = "mkdir " + "x".repeat(500);
    const ev = classifyLine(long, ctx);
    expect(ev).not.toBeNull();
    expect(ev!.description.length).toBe(200);
  });

  it("collapses internal runs of whitespace", () => {
    const ev = classifyLine("mkdir    a\t\tb", ctx);
    expect(ev!.description).toBe("mkdir a b");
  });
});
