// subagentTranscripts — the derivation that turns a parent's session transcript into the directory
// its orphaned subagents' partial work is really in (bead sparkle-y5dk8x).
//
// THE FIXTURES ARE OBSERVED PATHS, NOT CONSTRUCTED ONES. Every path below was read off disk while
// the layout was being established, and the expected directory is written out longhand rather than
// derived with the function under test — a test that builds its expectation from the implementation
// re-states the code and can never disagree with it.
//
// The measured layout, confirmed across 128 sessions:
//   <projects>/<slug>/<sessionId>.jsonl                       ← the PARENT's own transcript
//   <projects>/<slug>/<sessionId>/subagents/agent-<id>.jsonl  ← one file per dispatched subagent
//   <projects>/<slug>/<sessionId>/subagents/agent-<id>.meta.json
import { describe, expect, it } from "vitest";

import {
  SUBAGENT_TRANSCRIPT_GLOB,
  subagentRecoverySentence,
  subagentTranscriptDirFor,
} from "./subagentTranscripts";

const SLUG = "/Users/x/.claude/projects/-Users-x-Library-worktrees-ed5d-33c9";
const SESSION = "a9907495-45e0-426a-ba81-b0a29346a15a";
const PARENT = `${SLUG}/${SESSION}.jsonl`;
const EXPECTED_DIR = `${SLUG}/${SESSION}/subagents`;

describe("subagentTranscriptDirFor — the address of an orphaned fan-out's surviving work", () => {
  it("derives the observed on-disk directory from the parent's session transcript", () => {
    expect(subagentTranscriptDirFor(PARENT)).toBe(EXPECTED_DIR);
  });

  it("the session id becomes the DIRECTORY name — it is the file's stem, not a sibling", () => {
    // Pins the shape rather than one string: the directory must sit where the `.jsonl` file sits,
    // named for it. A `dirname`-then-rebuild implementation drops the session id and lands every
    // agent in one shared directory, which reads plausibly and is wrong for every reader.
    const dir = subagentTranscriptDirFor(PARENT) ?? "";
    expect(dir.startsWith(`${SLUG}/${SESSION}/`)).toBe(true);
    expect(dir.endsWith("/subagents")).toBe(true);
    expect(dir).not.toContain(".jsonl");
  });

  it("a relative path is handled the same way — no assumption of an absolute root", () => {
    expect(subagentTranscriptDirFor("sessions/abc.jsonl")).toBe("sessions/abc/subagents");
  });

  // ── FAILS CLOSED. Each of these must yield `undefined`, because the output is an instruction a
  //    reader will follow and a confidently wrong address costs more than no address at all. ───────
  it("returns undefined for a missing path", () => {
    expect(subagentTranscriptDirFor(undefined)).toBeUndefined();
    expect(subagentTranscriptDirFor(null)).toBeUndefined();
    expect(subagentTranscriptDirFor("")).toBeUndefined();
  });

  it("returns undefined for a WORKTREE directory rather than naming a path in the source tree", () => {
    // `agentTranscriptRegistry` writer (2) stores a worktree, resolved to a file only at read time.
    const worktree = "/Users/x/Projects/sparkle/.wt-feature";
    expect(subagentTranscriptDirFor(worktree)).toBeUndefined();
    expect(subagentTranscriptDirFor(`${worktree}/`)).toBeUndefined();
  });

  it("returns undefined for a non-transcript file, and for `.jsonl` appearing anywhere but the end", () => {
    expect(subagentTranscriptDirFor(`${SLUG}/${SESSION}.json`)).toBeUndefined();
    expect(subagentTranscriptDirFor(`${SLUG}/${SESSION}.jsonl.bak`)).toBeUndefined();
    expect(subagentTranscriptDirFor(`${SLUG}/a.jsonl.d/b.txt`)).toBeUndefined();
  });

  it("returns undefined for a bare suffix, which would otherwise name the filesystem ROOT", () => {
    // `".jsonl"` leaves an empty stem; a naive slice yields `"/subagents"` — an absolute path at
    // the root of the disk, the single most misleading answer this function could give.
    expect(subagentTranscriptDirFor(".jsonl")).toBeUndefined();
  });
});

describe("subagentRecoverySentence — the words that carry the address", () => {
  it("names the directory, the per-subagent glob, and the meta file that identifies each orphan", () => {
    const sentence = subagentRecoverySentence(PARENT) ?? "";
    expect(sentence).toContain(`${EXPECTED_DIR}/${SUBAGENT_TRANSCRIPT_GLOB}`);
    // The `.meta.json` sibling holds {agentType, description}: it is the only thing that says WHICH
    // task a given `agent-<id>.jsonl` was, which a parent that dispatched a batch of eight needs
    // before any of the transcripts are usable.
    expect(sentence).toContain("agent-<id>.meta.json");
  });

  it("says the partial work IS there — the claim the bead was filed to get", () => {
    const sentence = subagentRecoverySentence(PARENT) ?? "";
    // The bead: the notice "implied the work is fine when it is actually gone", and at minimum must
    // say the work is RECOVERABLE FROM THAT PATH. Both halves are asserted: recoverable, and that a
    // subagent which never reported still left its turns behind (the incremental-append property
    // measured at 187KB / 16 records while a subagent was still running).
    expect(sentence).toMatch(/recoverable/i);
    expect(sentence).toMatch(/never reported/);
  });

  it("is undefined — not a hedged sentence — when no directory can be derived", () => {
    // A single explicit absence, so the caller has one thing to branch on rather than having to
    // detect an address-shaped hole inside a string it was handed.
    expect(subagentRecoverySentence(undefined)).toBeUndefined();
    expect(subagentRecoverySentence("/Users/x/Projects/sparkle/.wt-feature")).toBeUndefined();
  });
});
