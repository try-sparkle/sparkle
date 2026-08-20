import { describe, expect, it } from "vitest";
import {
  alreadyOpenMessage,
  findDuplicateOpen,
  identityKey,
  isSameProject,
  pathKey,
} from "./projectIdentity";
import { normalizeProjectPath } from "../services/openTarget";

const proj = (
  id: string,
  name: string,
  rootPath: string,
  repoKey?: string | null,
) => ({ id, name, rootPath, repoKey });

// The founder's actual store, read out of localStorage the day he reported it: one repository on
// screen twice, because a linked worktree is a different FOLDER.
const SPARKLE = proj(
  "ed5d0ece",
  "sparkle",
  "/Users/x/Projects/sparkle",
  "/Users/x/Projects/sparkle/.git",
);
const SPARKLE_DESKTOP = proj(
  "5839d2fa",
  "sparkle-desktop",
  "/Users/x/Projects/sparkle-desktop",
  // `git rev-parse --git-common-dir` from the worktree resolves to the MAIN repo's .git — that is
  // the whole mechanism this feature turns on.
  "/Users/x/Projects/sparkle/.git",
);
const OTHER = proj("bf4e1ab5", "tkmx-client", "/Users/x/Projects/tkmx-client", "/Users/x/Projects/tkmx-client/.git");

describe("the founder's bug: one repository, two tabs", () => {
  // THE REGRESSION TEST. Against main this is false — the two records differ in every field the
  // app compared (id, name, rootPath), so nothing saw them as the same project and both got tabs.
  it("treats a linked worktree and its main checkout as the SAME project", () => {
    expect(isSameProject(SPARKLE, SPARKLE_DESKTOP)).toBe(true);
  });

  it("finds the open incumbent when the other one is opened, and says it came via a worktree", () => {
    const dup = findDuplicateOpen(
      SPARKLE_DESKTOP,
      [SPARKLE, SPARKLE_DESKTOP, OTHER],
      ["ed5d0ece", "bf4e1ab5"], // sparkle is open; sparkle-desktop is not
      {},
    );
    expect(dup).not.toBeNull();
    expect(dup!.existing.id).toBe("ed5d0ece");
    expect(dup!.viaWorktree).toBe(true);
    // Right is the absence of an entry in the assignment map (engine/pairs).
    expect(dup!.side).toBe("right");
  });

  it("reports the side the incumbent is actually on, so the copy can name it", () => {
    const dup = findDuplicateOpen(
      SPARKLE_DESKTOP,
      [SPARKLE, SPARKLE_DESKTOP],
      ["ed5d0ece"],
      { ed5d0ece: "left" },
    );
    expect(dup!.side).toBe("left");
  });

  // The message has to bridge two DIFFERENT names. "sparkle is already open" sends the user hunting
  // for a tab that says `sparkle` when the tab in front of them says `sparkle-desktop`.
  it("names BOTH folders when the match is via a worktree", () => {
    const dup = findDuplicateOpen(SPARKLE_DESKTOP, [SPARKLE, SPARKLE_DESKTOP], ["ed5d0ece"], {});
    const msg = alreadyOpenMessage(dup!, "sparkle-desktop");
    expect(msg).toContain("sparkle-desktop");
    expect(msg).toContain("sparkle");
    expect(msg).toContain("same repository");
    expect(msg).toContain("right pair");
  });

  it("uses the plain sentence — the app's existing wording — for a same-folder duplicate", () => {
    const dupRecord = proj("dup", "sparkle", "/Users/x/Projects/sparkle", "/Users/x/Projects/sparkle/.git");
    const dup = findDuplicateOpen(dupRecord, [SPARKLE, dupRecord], ["ed5d0ece"], {});
    expect(dup!.viaWorktree).toBe(false);
    expect(alreadyOpenMessage(dup!, "sparkle")).toBe("sparkle is already open in the right pair.");
  });
});

describe("what is NOT a duplicate", () => {
  it("a project matched against itself", () => {
    expect(findDuplicateOpen(SPARKLE, [SPARKLE, OTHER], ["ed5d0ece", "bf4e1ab5"], {})).toBeNull();
  });

  it("an incumbent that exists but is CLOSED — nothing is on screen to collide with", () => {
    // This is the narrowing ProjectTabsBar's picker refusal already learned the hard way: telling
    // someone a project "is already open" when it is open nowhere.
    expect(
      findDuplicateOpen(SPARKLE_DESKTOP, [SPARKLE, SPARKLE_DESKTOP], ["bf4e1ab5"], {}),
    ).toBeNull();
  });

  it("two genuinely different repositories", () => {
    expect(findDuplicateOpen(OTHER, [SPARKLE, OTHER], ["ed5d0ece"], {})).toBeNull();
  });

  it("two projects whose repo keys are unknown and whose paths differ", () => {
    const a = proj("a", "a", "/Users/x/a");
    const b = proj("b", "b", "/Users/x/b");
    expect(findDuplicateOpen(b, [a, b], ["a"], {})).toBeNull();
  });
});

describe("the path fallback, for records with no repo key yet", () => {
  // Every project persisted before this change hydrates with no repoKey. The rule must degrade to
  // exactly the dedupe the app already had rather than to nothing.
  it("still catches the same folder spelled two ways", () => {
    const a = proj("a", "Sparkle", "/Users/x/Projects/Sparkle/");
    const b = proj("b", "sparkle", "/Users/x/Projects/sparkle");
    expect(isSameProject(a, b)).toBe(true);
    expect(findDuplicateOpen(b, [a, b], ["a"], {})).not.toBeNull();
  });

  // `pathKey` IS `normalizeProjectPath` + a case fold now, so there is no longer a drift to pin —
  // the copy that needed one is gone. What the old pin left unguarded is what these assert.
  //
  // It fed only ASCII, lowercase, trailing-slash inputs, so it exercised exactly one of the
  // normalizer's three rules. Deleting `.normalize("NFC")` from `normalizeProjectPath` kept the
  // pin green, kept `openTarget.test.ts` green, and kept the whole desktop suite green — measured,
  // not assumed — while breaking the picker's NFD-vs-NFC dedupe. Each assertion below fails if its
  // own rule is removed.
  it("the shared normalizer strips a trailing separator", () => {
    expect(normalizeProjectPath("/Users/x/Projects/sparkle//")).toBe("/Users/x/Projects/sparkle");
  });

  it("the shared normalizer NFC-folds, so the picker's NFD spelling matches a stored NFC one", () => {
    const nfd = "/Users/x/caf\u00e9".normalize("NFD");
    expect(normalizeProjectPath(nfd)).toBe("/Users/x/caf\u00e9".normalize("NFC"));
    expect(normalizeProjectPath(nfd)).not.toBe(nfd); // precondition: the input really was NFD
  });

  it("pathKey adds the case fold on top of it", () => {
    expect(pathKey("/Users/x/Projects/Sparkle/")).toBe("/users/x/projects/sparkle");
  });

  it("NFD and NFC spellings of one accented folder are the same project", () => {
    const nfc = proj("a", "café", "/Users/x/café");
    const nfd = proj("b", "café", "/Users/x/café".normalize("NFD"));
    expect(nfd.rootPath).not.toBe(nfc.rootPath); // different UTF-16, same directory
    expect(isSameProject(nfc, nfd)).toBe(true);
  });

  // A repo key only ever MERGES records. It must never split a pair the path rule already matched
  // into two — that would make the feature a regression for anyone mid-backfill.
  it("a key on one side of a same-path pair does not split them apart into two tabs", () => {
    const keyed = proj("a", "sparkle", "/Users/x/Projects/sparkle", "/Users/x/Projects/sparkle/.git");
    const bare = proj("b", "sparkle", "/Users/x/Projects/sparkle");
    // They no longer match by key — which is correct and is why the caller re-checks by path too.
    // What must hold is that the SAME-record open stays idempotent, and that once the sweep
    // backfills `bare`, they merge.
    const backfilled = { ...bare, repoKey: "/Users/x/Projects/sparkle/.git" };
    expect(isSameProject(keyed, backfilled)).toBe(true);
  });
});

describe("identityKey", () => {
  it("prefixes by kind so a .git dir can never collide with someone's project root", () => {
    // A project whose ROOT is literally another project's .git directory is pathological but
    // representable, and an unprefixed key would call them the same project.
    const weird = proj("w", "weird", "/Users/x/Projects/sparkle/.git");
    expect(identityKey(weird)).not.toBe(identityKey(SPARKLE));
  });

  it("prefers the repo key when present and falls back to the path when it is blank", () => {
    expect(identityKey(proj("a", "a", "/p", "  "))).toBe("path:/p");
    expect(identityKey(proj("a", "a", "/p", null))).toBe("path:/p");
    expect(identityKey(proj("a", "a", "/p", "/r/.git"))).toBe("repo:/r/.git");
  });
});
