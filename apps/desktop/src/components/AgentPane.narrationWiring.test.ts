// A SOURCE GUARD over the one line of  that no behavioural test can reach.
//
// THE GAP THIS FILLS (AGENTS.md, "a defaulted seam every test injects"). `maybeNarrateActivity` is
// fully dependency-injected, so activityNarrator.test.ts drives it with its own clock, its own
// narrate fn and its own writer — and every one of those tests stays green if the REAL call site in
// AgentPane.tsx is deleted. The line that supplies the production values is covered by nothing:
// delete it and narration silently never runs, in exactly the way the feature is supposed to fix.
// There is no component test over AgentPane to catch it either (bead ).
//
// So this asserts the WIRING, scoped to the Stop branch rather than to the whole file — a bare
// file-wide grep for "maybeNarrateActivity" would be satisfied by the import statement alone, which
// is present whether or not anything calls it.
//
// It THROWS rather than returning "" when an anchor moves. That is the whole discipline: a slice
// that silently comes back empty makes every `toContain` on it vacuous, and the guard then passes
// forever over a file nobody opened.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// fileURLToPath, never `.pathname` — every worktree on this machine lives under a path containing a
// space ("Application Support"), which a URL pathname percent-encodes into a directory that does not
// exist. `.pathname` here is ENOENT at best and a silently empty read at worst.
const SRC = readFileSync(
  fileURLToPath(new URL("./AgentPane.tsx", import.meta.url)),
  "utf8",
);

/** Slice the Stop branch's transcript-read block: from the read to the judge call that ends it. */
function stopBranchBody(): string {
  const open = "read_transcript_last_assistant";
  const close = "maybeJudgeFollowup(text, turn)";

  const firstOpen = SRC.indexOf(open);
  if (firstOpen < 0) {
    throw new Error(
      `AgentPane.tsx no longer contains "${open}" — the Stop-branch transcript read moved or was ` +
        "renamed. Re-anchor this guard; do NOT delete it.",
    );
  }
  if (SRC.indexOf(open, firstOpen + 1) >= 0) {
    throw new Error(`"${open}" appears more than once in AgentPane.tsx — the slice is ambiguous.`);
  }
  const closeAt = SRC.indexOf(close, firstOpen);
  if (closeAt < 0) {
    throw new Error(
      `AgentPane.tsx no longer contains "${close}" after the transcript read — re-anchor this guard.`,
    );
  }
  const body = SRC.slice(firstOpen, closeAt);
  // A truncated slice is how this class of guard goes vacuously green. The real block is well over
  // this; the floor only has to be big enough that a collapsed slice cannot satisfy it.
  if (body.length < 200) {
    throw new Error(
      `the sliced Stop branch is only ${body.length} chars — that is a broken slice, not a small ` +
        "branch. Fix the anchors rather than lowering this floor.",
    );
  }
  return body;
}

describe("AgentPane Stop branch wires activity narration (bead )", () => {
  it("calls maybeNarrateActivity inside the Stop branch, not merely imports it", () => {
    // Scoped to the branch: a file-wide grep would pass on the import line alone.
    expect(stopBranchBody()).toContain("maybeNarrateActivity(");
  });

  it("attributes the write to the NARRATED source, not the default self-report", () => {
    // setAgentActivity defaults its source to "self". Omitting the argument here compiles fine and
    // is invisible at runtime — it just relabels every generated line as something the agent said,
    // which is precisely the confusion this bead exists to remove.
    expect(stopBranchBody()).toContain('"narrated"');
  });

  it("feeds the throttle the agent's real last-write stamp", () => {
    // Passing `lastNarratedAt: undefined` would compile, and shouldNarrate reads undefined as
    // "never narrated" → ALWAYS narrate. That silently defeats the 60s throttle and bills the
    // user's subscription on every single turn of every agent.
    const body = stopBranchBody();
    expect(body).toContain("lastNarratedAt");
    expect(body).toContain("activityAt");
  });

  it("passes the existing line's provenance, or the self-report protection is inert", () => {
    // `existingSource` is optional-shaped at the call site in the sense that omitting it yields
    // undefined — which shouldNarrate reads as a LEGACY SELF-REPORT and would protect. That is the
    // safe direction, but it would also mean the narrator never distinguishes its own previous line
    // from the agent's, so a narrated line would protect itself forever and the feature would stop
    // refreshing after its first success. Compiles fine; invisible at runtime (roborev 82272).
    expect(stopBranchBody()).toContain("existingSource");
  });

  it("does not await narration ahead of the followup judge", () => {
    // The judge decides whether this row goes RED. A model call for a muted secondary line must not
    // sit in front of it — `void` is load-bearing, not a lint appeasement.
    expect(stopBranchBody()).toMatch(/void\s+maybeNarrateActivity\(/);
  });
});
