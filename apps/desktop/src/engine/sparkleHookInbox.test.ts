/**
 * Tests for the Level 2 delivery half of the shipped hook emitter
 * (`src-tauri/resources/sparkle-hook.mjs`).
 *
 * The end-to-end behaviour these guard: a message queued for an agent is injected back into it at
 * its next `Stop` — its natural turn boundary — and never twice.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error - plain .mjs, only the pure helpers are typed for tests
import { draftDelivery, inboxPaths, pendingMessages } from "../../src-tauri/resources/sparkle-hook.mjs";

const SCRIPT = fileURLToPath(
  new URL("../../src-tauri/resources/sparkle-hook.mjs", import.meta.url),
);

let root: string;
let logPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sparkle-hook-inbox-"));
  mkdirSync(join(root, "hook-events"), { recursive: true });
  logPath = join(root, "hook-events", "agent-1.jsonl");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function queue(id: string, text: string, severity = "fyi", ts = Date.now()) {
  const dir = join(root, "inbox");
  mkdirSync(dir, { recursive: true });
  const line = `${JSON.stringify({ id, ts, from: "concierge", text, severity })}\n`;
  const path = join(dir, "agent-1.jsonl");
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    /* first message */
  }
  writeFileSync(path, existing + line);
}

/** Run the hook exactly as Claude Code does: payload on stdin, log path as argv[2]. */
function fireHook(event: string): string {
  return execFileSync("node", [SCRIPT, logPath], {
    input: JSON.stringify({ hook_event_name: event, session_id: "s1" }),
    encoding: "utf8",
  });
}

describe("inboxPaths", () => {
  it("derives every inbox path from the log path alone", () => {
    // This is what lets already-installed agents gain delivery with no settings migration.
    const p = inboxPaths("/app-data/hook-events/abc-123.jsonl");
    expect(p.agentId).toBe("abc-123");
    expect(p.messages).toBe("/app-data/inbox/abc-123.jsonl");
    expect(p.acks).toBe("/app-data/inbox/abc-123.acks.jsonl");
    expect(p.claims).toBe("/app-data/inbox/claims/abc-123");
  });
});

describe("pendingMessages", () => {
  const never = () => false;

  it("skips malformed lines rather than failing the whole inbox", () => {
    const raw = ['{"id":"a","text":"one","ts":1}', "{not json", "", '{"id":"b","text":"two","ts":1}'].join(
      "\n",
    );
    expect(pendingMessages(raw, 1, never).map((m: { id: string }) => m.id)).toEqual(["a", "b"]);
  });

  it("skips records missing an id or text", () => {
    const raw = ['{"text":"no id","ts":1}', '{"id":"x","ts":1}', '{"id":"ok","text":"y","ts":1}'].join("\n");
    expect(pendingMessages(raw, 1, never).map((m: { id: string }) => m.id)).toEqual(["ok"]);
  });

  it("drops expired messages", () => {
    const raw = '{"id":"old","text":"stale","ts":0}';
    expect(pendingMessages(raw, 13 * 60 * 60 * 1000, never)).toEqual([]);
  });

  it("skips already-claimed messages", () => {
    const raw = ['{"id":"a","text":"one","ts":1}', '{"id":"b","text":"two","ts":1}'].join("\n");
    const claimed = (id: string) => id === "a";
    expect(pendingMessages(raw, 1, claimed).map((m: { id: string }) => m.id)).toEqual(["b"]);
  });

  it("caps one drain so a backlog cannot bury the agent", () => {
    const raw = Array.from({ length: 40 }, (_, i) => `{"id":"m${i}","text":"t","ts":1}`).join("\n");
    expect(pendingMessages(raw, 1, never)).toHaveLength(10);
  });
});

describe("draftDelivery", () => {
  it("marks ACT and FYI distinctly and names the ack path", () => {
    const text = draftDelivery(
      [
        { id: "m1", text: "main has moved, rebase", severity: "act" },
        { id: "m2", text: "fyi only", severity: "fyi" },
      ],
      "/app-data/inbox/a.acks.jsonl",
      1234,
    );
    expect(text).toContain("(ACT) main has moved, rebase");
    expect(text).toContain("(FYI) fyi only");
    expect(text).toContain("/app-data/inbox/a.acks.jsonl");
    expect(text).toContain('"id":"m1"');
  });

  it("only ever asks the agent to append to the app's own data dir", () => {
    // The safety property of this copy: a half-followed instruction cannot damage the repo,
    // the branch, or anything else the agent is working on.
    const text = draftDelivery([{ id: "m1", text: "x", severity: "act" }], "/app-data/inbox/a.acks.jsonl", 1);
    expect(text).toContain(">> '/app-data/inbox/a.acks.jsonl'");
    expect(text).not.toMatch(/\bgit\b/);
    expect(text).not.toMatch(/\brm\b/);
  });
});

describe("the hook at a turn boundary", () => {
  it("delivers a queued message on Stop, as a block decision", () => {
    queue("m1", "main has moved, rebase before verifying", "act");
    const out = fireHook("Stop");
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("main has moved, rebase before verifying");
    expect(parsed.reason).toContain("(ACT)");
  });

  it("does NOT deliver on a non-Stop event — delivery is only at a boundary", () => {
    queue("m1", "should wait for the boundary");
    // PreToolUse fires mid-task; injecting there is exactly the interruption L2 exists to avoid.
    expect(fireHook("PreToolUse")).toBe("");
    // And the message is still there for the real boundary.
    expect(JSON.parse(fireHook("Stop")).reason).toContain("should wait for the boundary");
  });

  it("does not block a second time — the claim is the loop guard", () => {
    // Without claiming before injecting, every Stop would re-deliver and the agent could never
    // finish a turn.
    queue("m1", "deliver me once");
    expect(JSON.parse(fireHook("Stop")).reason).toContain("deliver me once");
    expect(fireHook("Stop")).toBe("");
    expect(fireHook("Stop")).toBe("");
  });

  it("stays silent when there is no inbox at all — the common case", () => {
    expect(fireHook("Stop")).toBe("");
  });

  it("delivers a message queued AFTER an earlier drain", () => {
    queue("m1", "first");
    expect(JSON.parse(fireHook("Stop")).reason).toContain("first");
    expect(fireHook("Stop")).toBe("");

    queue("m2", "second");
    const out = JSON.parse(fireHook("Stop"));
    expect(out.reason).toContain("second");
    expect(out.reason).not.toContain("first");
  });

  it("still records the event to the log even when it delivers", () => {
    queue("m1", "x");
    fireHook("Stop");
    const events = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.at(-1)?.event).toBe("Stop");
  });

  it("a corrupt inbox does not stop the agent finishing its turn", () => {
    // The contract the emitter has always had: never surface a failure to Claude.
    mkdirSync(join(root, "inbox"), { recursive: true });
    writeFileSync(join(root, "inbox", "agent-1.jsonl"), "{{{ not json at all\n");
    expect(fireHook("Stop")).toBe("");
    // And the event was still logged.
    expect(readFileSync(logPath, "utf8")).toContain('"Stop"');
  });

  it("batches several queued messages into one delivery", () => {
    queue("m1", "alpha");
    queue("m2", "beta");
    const reason = JSON.parse(fireHook("Stop")).reason;
    expect(reason).toContain("alpha");
    expect(reason).toContain("beta");
    expect(reason).toContain("2 message(s)");
    expect(fireHook("Stop")).toBe("");
  });
});
