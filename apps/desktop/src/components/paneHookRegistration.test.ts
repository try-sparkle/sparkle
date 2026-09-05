// @vitest-environment node
//
// EVERY PANE THAT SPAWNS `claude` INTO A WORKTREE MUST REGISTER THE EVENT-HOOK EMITTER.
//
// THE OUTAGE THIS EXISTS TO PREVENT (beads sparkle-6yrvqd, sparkle-eou3y0.1). `AgentPane.prepare`
// called `installWorktreeGuard` AND `installAgentHooks`. `SparkleAgentPane.prepare` called only
// the guard. That one missing call meant the app-owned Improve-Sparkle worktree registered two
// hook events — the write-guard's `PreToolUse` and a repo cadence script's `UserPromptSubmit` —
// where an ordinary agent worktree registers nine, and NEITHER of those two is the emitter.
//
// The inbox drain rides the `Stop` hook. So it never ran. Measured on the machine: 145 records
// queued, 42 of them still live, `delivered: 0` and `acknowledged: 0` for the inbox's ENTIRE
// LIFETIME, zero claim files, and no acks file at all. Two agents each spent a session believing
// they were coordinating with the other, and the founder reported it as "improved sparkle is not
// getting your messages". It then sealed its own repair channel: a queue full of `act` messages
// refuses the `fyi` sends that would have told the agent to drain it.
//
// WHY A SOURCE SCAN AND NOT TWO MORE RENDER TESTS. Both panes are individually covered already
// (`AgentPane.inboxOwner.test.tsx`, `SparkleAgentPane.inboxDrain.test.tsx`), and both were green
// throughout the outage — because a per-pane test can only assert about a pane somebody remembered
// to write a test for. The defect was not a broken call, it was a MISSING one in a file nobody
// thought to check, and the next pane added will be missing it the same way. This asserts the
// CLASS: whatever spawns claude into a worktree registers the emitter, including files that do not
// exist yet.
//
// WHAT THIS DELIBERATELY DOES NOT ASSERT: that both panes install the SAME installer.
// `installAgentHooks` also pre-enables plugins and writes the permission posture;
// `installInboxDrainHooks` is the surgical variant that writes event hooks and nothing else. An
// app-owned worktree's posture is set elsewhere and must not change as a side effect of
// registering a mailbox, so the two callers are correctly different. What must NOT differ is that
// each registers the emitter at all — that is the hook set `merge_event_hooks` writes, identical
// for both.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// `fileURLToPath`, never `.pathname`. EVERY worktree on the machines this runs on lives under
// `~/Library/Application Support/…`, so a URL pathname comes back percent-encoded as
// `Application%20Support` — a directory that does not exist. The tolerant version of that mistake
// is the dangerous one: a walk that swallows ENOENT returns `[]`, and a ratchet over zero files
// passes forever (AGENTS.md, bead sparkle-uabf2k). Hence also the floor asserted below.
import { fileURLToPath } from "node:url";

const COMPONENTS = fileURLToPath(new URL(".", import.meta.url));

/** A call that hands `claude` a worktree to run in — the property that creates the obligation. */
const SPAWNS_CLAUDE = /\b(?:buildClaudeExec|assembleBuildSpawn)\s*\(/;

/** Either installer registers the emitter on all nine events; both go through `merge_event_hooks`. */
const REGISTERS_EMITTER = /\b(?:installAgentHooks|installInboxDrainHooks)\s*\(/;

/**
 * The source with COMMENTS REMOVED — and this is load-bearing, not tidiness.
 *
 * The first cut of this guard scanned the raw file, and `mutation-check` immediately FLAGGED it:
 * commenting out `await installInboxDrainHooks(wt.path);` left the ratchet GREEN, because the
 * identifier is still right there inside `// await installInboxDrainHooks(wt.path);`. A guard that
 * accepts a commented-out call is worse than no guard — it reports the obligation as met at exactly
 * the moment somebody disabled it, which is the same "absence of evidence read as health" shape as
 * the outage it exists to prevent.
 *
 * Block comments go first, then whatever follows `//` on each surviving line. Crude by design: the
 * question is only "does a real call appear", so a string literal that happens to contain `//` can
 * cost this scan the rest of that line and nothing more — it can make the guard STRICTER, never
 * more permissive, and stricter is the safe direction for a ratchet whose failure fires an alarm.
 */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

/**
 * The panes that spawn claude, as `[filename, source]`.
 *
 * Tests, stories and type-only files are excluded — a test file naturally MENTIONS both calls and
 * would satisfy the obligation without any production code doing so, which is how a class ratchet
 * quietly becomes vacuous.
 */
function spawningPanes(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of readdirSync(COMPONENTS, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith(".tsx") && !name.endsWith(".ts")) continue;
    if (name.includes(".test.") || name.includes(".stories.")) continue;
    const src = withoutComments(readFileSync(join(COMPONENTS, name), "utf8"));
    if (SPAWNS_CLAUDE.test(src)) out.push([name, src]);
  }
  return out;
}

describe("every pane that spawns claude registers the hook emitter", () => {
  /**
   * THE ANTI-VACUITY FLOOR, and it is not decoration. Every assertion below is of the shape "for
   * each file found…", which is trivially satisfied by finding no files. A wrong directory, a
   * renamed component, a percent-encoded path — each turns this suite green over a tree nobody
   * opened, and it stays green forever. Two is the honest floor: `AgentPane` and
   * `SparkleAgentPane` are the panes that spawn claude today, and if either stops being found the
   * scan is broken, not the code.
   */
  it("finds the panes it is supposed to be scanning", () => {
    const names = spawningPanes().map(([n]) => n);
    expect(
      names.length,
      `expected at least 2 claude-spawning panes under ${COMPONENTS}; found ${names.length} ` +
        `(${names.join(", ") || "none"}). A scan that finds nothing passes every per-file ` +
        "assertion below, so this floor is what stops the ratchet going vacuous.",
    ).toBeGreaterThanOrEqual(2);
    expect(names).toContain("AgentPane.tsx");
    expect(names).toContain("SparkleAgentPane.tsx");
  });

  it.each(spawningPanes().map(([name]) => name))(
    "%s registers the event-hook emitter for the worktree it spawns into",
    (name) => {
      const src = spawningPanes().find(([n]) => n === name)?.[1] ?? "";
      expect(
        REGISTERS_EMITTER.test(src),
        `${name} spawns claude into a worktree but never calls installAgentHooks or ` +
          "installInboxDrainHooks. The inbox drain rides the Stop hook, which only exists if one " +
          "of those ran — without it every peer message queued to that agent is accepted, " +
          "acknowledged with a message id, and delivered to nobody, forever, with nothing " +
          "reporting it (bead sparkle-6yrvqd). Call one of them in prepare(), beside " +
          "installWorktreeGuard.",
      ).toBe(true);
    },
  );

  /**
   * ...and the guard is not a substitute for the emitter. These two were conflated once already:
   * the app-owned worktree HAD `installWorktreeGuard`, which writes a `PreToolUse` entry and the
   * permission posture, so its settings file looked populated — `PreToolUse` present, permissions
   * present, `bypassPermissions` set — while carrying no `Stop` hook at all. A file that looks
   * configured is exactly why nobody checked it for months.
   */
  it("does not accept the worktree write-guard as the emitter", () => {
    for (const [name, src] of spawningPanes()) {
      const guardOnly = /\binstallWorktreeGuard\s*\(/.test(src) && !REGISTERS_EMITTER.test(src);
      expect(
        guardOnly,
        `${name} installs the worktree write-guard but no event-hook emitter. The guard writes a ` +
          "PreToolUse entry and the permission posture, which makes settings.local.json LOOK " +
          "configured while the drain has nothing to ride on.",
      ).toBe(false);
    }
  });
});
