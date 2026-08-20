import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  __clearRepoSlugCache,
  __setRepoSlugForTest,
  primeRepoSlug,
  primeRepoSlugs,
  slugForRoot,
} from "./repoSlug";

/**
 * The slug cache exists so a SYNCHRONOUS policy can ask an ASYNCHRONOUS question. Two properties
 * carry the whole design and both fail silently if they break:
 *
 *  1. a MISS returns null — which is foreign, which asks. Anything else is a widening.
 *  2. a missing/failing Rust command degrades to null rather than throwing, because this runs
 *     underneath the tool-dispatch gate and a throw there takes out the decision itself.
 */
describe("repoSlug", () => {
  beforeEach(() => {
    invoke.mockReset();
    __clearRepoSlugCache();
  });

  it("a MISS is null — never a guess", () => {
    expect(slugForRoot("/repos/never-primed")).toBeNull();
    expect(slugForRoot(null)).toBeNull();
    expect(slugForRoot(undefined)).toBeNull();
    expect(slugForRoot("   ")).toBeNull();
  });

  it("resolves through the Rust command and answers synchronously afterwards", async () => {
    invoke.mockResolvedValue("DROdio/Sparkle");
    primeRepoSlug("/repos/sparkle");
    // The SIDE EFFECT, and note it is not readable yet — the read is sync, the fill is not.
    expect(slugForRoot("/repos/sparkle")).toBeNull();
    await vi.waitFor(() => expect(slugForRoot("/repos/sparkle")).toBe("drodio/sparkle"));
    expect(invoke).toHaveBeenCalledWith("repo_slug_for_root", { root: "/repos/sparkle" });
  });

  it("a MISSING Rust command degrades to null instead of throwing into the dispatch path", async () => {
    // This is the state of the worktree while the Rust half is still being written, and the state
    // of any build that predates the command. It must be indistinguishable from "not resolved".
    invoke.mockRejectedValue(new Error("Command repo_slug_for_root not found"));
    expect(() => primeRepoSlug("/repos/unknown")).not.toThrow();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(slugForRoot("/repos/unknown")).toBeNull();
  });

  it("a SYNCHRONOUSLY throwing invoke is caught too", () => {
    invoke.mockImplementation(() => {
      throw new Error("no tauri here");
    });
    expect(() => primeRepoSlug("/repos/browser")).not.toThrow();
    expect(slugForRoot("/repos/browser")).toBeNull();
  });

  it("a failed prime is RETRYABLE; a resolved one is not re-asked", async () => {
    invoke.mockRejectedValueOnce(new Error("boom"));
    primeRepoSlug("/repos/x");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    // A failed prime caches NOTHING, so a later one must be able to try again. Re-primed inside
    // the poll because the in-flight marker clears on its own microtask, and the point of the
    // assertion is that a retry EVENTUALLY lands — not that it lands on any particular tick.
    invoke.mockResolvedValue("o/r");
    await vi.waitFor(() => {
      primeRepoSlug("/repos/x");
      expect(slugForRoot("/repos/x")).toBe("o/r");
    });
    // Resolved now — asking again must not spend another round trip.
    const spent = invoke.mock.calls.length;
    expect(spent).toBeGreaterThanOrEqual(2);
    primeRepoSlug("/repos/x");
    expect(invoke.mock.calls.length).toBe(spent);
  });

  it("coalesces concurrent primes for one root", () => {
    invoke.mockReturnValue(new Promise(() => {}));
    primeRepoSlug("/repos/y");
    primeRepoSlug("/repos/y");
    primeRepoSlug("/repos/y/");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("a non-slug answer from Rust is null, not the raw string", async () => {
    for (const junk of ["", "sparkle", "a/b/c", 7, null, { owner: "x" }]) {
      __clearRepoSlugCache();
      invoke.mockReset();
      invoke.mockResolvedValue(junk);
      primeRepoSlug("/repos/junk");
      await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
      await vi.waitFor(() => expect(slugForRoot("/repos/junk")).toBeNull());
    }
  });

  it("a trailing slash is the same root", () => {
    __setRepoSlugForTest("/repos/z", "o/r");
    expect(slugForRoot("/repos/z/")).toBe("o/r");
    expect(slugForRoot("  /repos/z  ")).toBe("o/r");
  });

  it("primeRepoSlugs skips the unusable roots without throwing", () => {
    invoke.mockResolvedValue("o/r");
    primeRepoSlugs(["/repos/a", null, undefined, "  ", "/repos/b"]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
