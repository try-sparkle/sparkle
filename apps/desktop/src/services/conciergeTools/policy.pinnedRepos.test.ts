// The SHIPPED PIN, pinned against the file it is meant to mirror.
//
// `policy.ts` declares `MERGE_PROTECTED_SLUGS` as a literal rather than importing
// `shared/merge-protected-repos.json`, because importing JSON there would mean a build-config
// change (`resolveJsonModule` plus whatever the bundler does with the asset) in a module that is
// loaded on every tool call. The cost of the literal is that it can drift from the file the Rust
// side and the worktree writer read — so this test reads the file FROM DISK and asserts they agree,
// exactly as `worktree.rs` pins `SPARKLE_DENY_RULES` against `destructive-commands.json`.
//
// The assertion is on the SIDE EFFECT, not on the shape: for every slug in the file, the predicate
// the concierge actually consults must answer true. A test that only compared array contents would
// stay green if `isPinnedMergeProtectedSlug` stopped reading the list.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateToolPolicy,
  isPinnedMergeProtectedSlug,
  MERGE_PROTECTED_SLUGS,
  projectPolicyContextFor,
} from "./policy";

const SHARED_JSON = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../shared/merge-protected-repos.json",
);

interface PinFile {
  version: number;
  pinnedSlugs: string[];
}

function readPinFile(): PinFile {
  return JSON.parse(readFileSync(SHARED_JSON, "utf8")) as PinFile;
}

describe("the shipped merge-protection pin", () => {
  it("the TypeScript list is exactly the shared JSON's list", () => {
    const file = readPinFile();
    expect(file.version).toBe(1);
    // NON-VACUITY, ASSERTED FIRST. Every other test in this file is a `for … of pinnedSlugs` loop,
    // so an emptied list would pass all of them on zero iterations while the whole merge-protection
    // floor was gone — and emptying BOTH sides is a plausible single edit (a "cleanup", a bad
    // merge). A duplicate entry would also make the sorted-array compare below fail confusingly
    // rather than report itself, so it is named here too.
    expect(file.pinnedSlugs.length).toBeGreaterThan(0);
    expect(new Set(file.pinnedSlugs).size).toBe(file.pinnedSlugs.length);
    expect(new Set(MERGE_PROTECTED_SLUGS).size).toBe(MERGE_PROTECTED_SLUGS.length);
    expect([...MERGE_PROTECTED_SLUGS].sort()).toEqual([...file.pinnedSlugs].sort());
  });

  it("every slug in the file actually denies a merge, whatever the config says", () => {
    // THE SIDE EFFECT. A slug added to the JSON and forgotten in `policy.ts` fails HERE, at the
    // decision — which is the thing the file exists to guarantee — rather than at a list compare.
    for (const slug of readPinFile().pinnedSlugs) {
      expect(isPinnedMergeProtectedSlug(slug), slug).toBe(true);
      const evaluation = evaluateToolPolicy("merge_pr", {
        // The most permissive configuration anyone could write: allowed globally, allowed for this
        // project, and the org claimed as our own. The pin still holds.
        overrides: { merge_pr: "allow" },
        project: projectPolicyContextFor(slug, [slug.split("/")[0] ?? ""], {
          [slug]: { merge_pr: "allow" },
        }),
      });
      expect(evaluation.decision, slug).toBe("deny");
      expect(evaluation.source, slug).toBe("pinned-repo");
    }
  });

  it("the file's slugs are lowercase owner/repo — the form every comparison assumes", () => {
    for (const slug of readPinFile().pinnedSlugs) {
      expect(slug, slug).toBe(slug.toLowerCase());
      expect(slug.split("/"), slug).toHaveLength(2);
    }
  });
});

// THE INVARIANT THAT FAILS OPEN, asserted rather than described (roborev 65384, finding 2).
//
// `isPinnedMergeProtectedSlug` lowercases the INCOMING slug and then tests set membership. So a
// fixture entry that is not already lowercase can never match anything: a hand-edited
// `Plow-PBC/tkmx-web` would silently lose its pin, and NOTHING would go red — the TypeScript
// constant, the Rust constant and this fixture would all agree on the same mis-cased string, so
// every anti-drift test above stays green while the repo it names becomes mergeable.
//
// A prose comment is the wrong device for an invariant whose violation is invisible, and this file's
// entire premise is that the rule survives without anyone remembering it. Hence a shape assertion.
describe("the pinned slug list has a shape that can actually match", () => {
  it("every entry is a lowercase owner/repo with no whitespace or URL prefix", () => {
    for (const slug of readPinFile().pinnedSlugs) {
      expect(slug, `${slug} must be lowercase owner/repo`).toMatch(
        /^[a-z0-9._-]+\/[a-z0-9._-]+$/,
      );
      expect(slug, `${slug} must not be padded`).toBe(slug.trim());
    }
  });

  it("is non-empty and free of duplicates", () => {
    // Vacuity guard: an empty list would satisfy every "matches the constant" assertion above while
    // protecting nothing at all.
    const slugs = readPinFile().pinnedSlugs;
    expect(slugs.length).toBeGreaterThan(0);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
