// THE FEATURE IS MOUNTED. That is the assertion, and it is the most valuable one in this folder.
//
// Every other test here passes against a router that NEVER RUNS, because every module under test is
// pure and driven by injected seams. Greenness therefore says nothing at all about whether an
// @mention in a real bead comment wakes anybody — and this repo has shipped that exact non-feature
// twice already, in the same problem area:
//
//   - `apps/desktop/src-tauri/src/mention.rs` registers four Tauri commands. A Tauri command is
//     reachable only from the frontend, and `git grep mention_send -- apps/desktop/src` finds
//     nothing. All four are dead in the shipped binary.
//   - The mention compose UI is seventeen components under `components/MentionCompose/` that nothing
//     outside that directory imports.
//
// Both are complete, both are tested, neither has ever run (bead `sparkle-wyc9j`: six PRs merged
// with zero consumers, and a dormant-module allowlist that legitimised it for 60 days). Nothing in
// CI, coverage, or review caught either one. So the wiring gets a test of its own, and deleting the
// mount fails HERE rather than being discovered months later by someone asking why @mentions do
// nothing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appTsx = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../App.tsx",
);

describe("the bead-mention watcher is wired to a surface", () => {
  const src = readFileSync(appTsx, "utf8");

  it("App.tsx imports the watcher's entry point", () => {
    expect(src).toContain("startBeadMentionWatch");
  });

  it("App.tsx actually RENDERS the mount, not merely imports it", () => {
    // Importing without rendering is the same dead code with an extra step — and it is what an
    // over-eager "remove unused component" cleanup leaves behind.
    expect(src).toContain("<BeadMentionWatch />");
  });

  it("the mount is gated to the main window, because the watcher WRITES", () => {
    // Not cost, correctness: it queues inbox messages and posts bead comments, so a second window
    // means two doorbells and two comments for one mention. The gate lives in the component, so pin
    // that the component consults it rather than trusting the comment above it.
    const component = src.slice(src.indexOf("function BeadMentionWatch()"));
    expect(component.slice(0, 400)).toContain("useIsMainWindow");
  });
});
