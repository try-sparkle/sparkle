// scripts/sparkle-scrub.sh — the hard PII/secret gate the Sparkle improvement agent must run on
// PR text before any `gh pr create` (beads sparkle-4xwk.1 / ). Exercised for real via
// child_process: exit 0 on clean text, exit 1 with named+redacted findings on dirty text.
// POSIX-only (bash + grep), so skipped on Windows.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/sparkle-scrub.sh");

function scrub(content: string): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "sparkle-scrub-"));
  const file = join(dir, "pr.txt");
  writeFileSync(file, content);
  chmodSync(file, 0o600);
  const r = spawnSync("bash", [SCRIPT, file], { encoding: "utf8", env: { ...process.env, USER: "testuser" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(process.platform === "win32")("scripts/sparkle-scrub.sh", () => {
  it("exits 0 on a clean PR body", () => {
    const r = scrub(
      "Fix worktree creation race\n\nThe guard now installs before integrity checks.\nAcceptance: no regressions in the spawn path.\n",
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("exits 1 and names each pattern on a dirty PR body, redacting the matched values", () => {
    const email = "alice.doe@example.com";
    // Split so no contiguous secret-shaped literal appears in source (mirror leak-check / gitleaks);
    // the runtime value is still a real-shaped key so scrub() is genuinely exercised.
    const key = "sk-" + "abcdef1234567890XYZ";
    const r = scrub(`Contact ${email} about the bug\nRepro lives in /Users/alicedoe/projects\nToken: ${key}\n`);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("email-address");
    expect(r.stdout).toContain("home-directory-path");
    expect(r.stdout).toContain("anthropic/openai-style-key");
    // Matched values are redacted to their first 4 chars — never echoed in full.
    expect(r.stdout).not.toContain(email);
    expect(r.stdout).not.toContain(key);
    expect(r.stdout).toContain("alic…[redacted]");
    expect(r.stdout).toContain("sk-a…[redacted]");
  });

  it("redacts CROSS-pattern: two secret types on one line never leak each other's value", () => {
    // The leak roborev flagged on the original scan(): the email finding used to echo the sk-
    // key raw (and vice versa) because each pass redacted only its own pattern's matches.
    // redact_all now scrubs every printed line against the FULL pattern table.
    const email = "alice.doe@example.com";
    // Split so no contiguous secret-shaped literal appears in source (mirror leak-check / gitleaks);
    // the runtime value is still a real-shaped key so scrub() is genuinely exercised.
    const key = "sk-" + "abcdef1234567890XYZ";
    const r = scrub(`Contact ${email} and use ${key} to repro\n`);
    expect(r.status).toBe(1);
    // Both findings fire for the same line…
    expect(r.stdout).toContain("email-address");
    expect(r.stdout).toContain("anthropic/openai-style-key");
    // …and NEITHER echoes the other's raw value anywhere in the output.
    expect(r.stdout).not.toContain(email);
    expect(r.stdout).not.toContain(key);
  });

  it("flags the machine's $USER as a word", () => {
    const r = scrub("Reported by testuser during triage.\n");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("local-username($USER)");
  });

  it("flags long high-entropy blobs as WARNING but still fails the gate", () => {
    const r = scrub(`Hash observed: ${"deadbeef".repeat(6)}\n`);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("WARNING");
    expect(r.stdout).toContain("high-entropy-hex-blob");
  });

  it("exits 2 on a missing file (usage error, not a pass)", () => {
    const r = spawnSync("bash", [SCRIPT, "/nonexistent/sparkle-scrub-fixture.txt"], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});
