// @vitest-environment jsdom
//
// THE DOCUMENTED DEV UNLOCK ACTUALLY UNLOCKS THE CONCIERGE (bead sparkle-wfev6).
//
// A fresh dev profile has no Sparkle account, so `ConciergeColumn` renders `ConciergeAiLocked` with
// no thread and no compose box — which made the standing "verify concierge changes in a running
// build" instruction unexecutable. The remedy this repo now documents
// (docs/orchestration-live-verification.md § 1a) is the EXISTING dev-only auth bypass:
//
//     VITE_SPARKLE_DEV_BYPASS_AUTH=1 pnpm tauri dev
//
// Nothing was built for it and nothing was loosened; the fix is documentation. What a doc CANNOT do
// is stay true, and this file is the part that can: a remedy message is an instruction the reader
// will follow, so the one assertion worth making is that following it clears the lock.
//
// IT DRIVES THE REAL SEAMS, END TO END, AND THAT IS THE POINT. Not a hand-built `me` — the actual
// `authStore.refresh()` reading the actual `devBypassAuthEnabled()` off the actual env key, judged
// by the actual `useConciergeAiLock()` the column renders from. Stub any one of those and the test
// would pass while the documented command did nothing (AGENTS.md: "a defaulted seam every test
// injects"). The env is the only thing stubbed, because the env is what the reader types.
//
// BOTH DIRECTIONS, because "the lock is clear" alone would pass against a build that never locks:
// the same refresh() with the flag absent must still land on `not_entitled`, which is the fresh
// dev profile the bead reports.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

// The signed-out shape of a FRESH profile: no token in the keychain. Only reached on the flag-absent
// branch — with the bypass on, refresh() short-circuits before it, which is the whole mechanism.
vi.mock("../services/sparkleApi", () => ({
  hasToken: vi.fn(async () => false),
  fetchMe: vi.fn(async () => null),
}));

import { DEV_BYPASS_AUTH_FLAG } from "./devBypassAuth";
import { useAuthStore } from "../stores/authStore";
import { useConciergeAiLock } from "../components/Concierge/conciergeAiLock";
import { CONCIERGE_DEV_UNLOCK_COMMAND } from "../components/Concierge/ConciergeAiLocked";

function lockNow() {
  return renderHook(() => useConciergeAiLock()).result.current;
}

beforeEach(() => {
  useAuthStore.setState({ me: null, tokenPresent: false, cachedAt: null, creditFloorCents: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the fresh dev profile the bead reports", () => {
  it("is AI-LOCKED on `not_entitled` — the column's thread and composer are replaced", async () => {
    await useAuthStore.getState().refresh();
    expect(useAuthStore.getState().me).toBeNull();
    expect(lockNow()).toBe("not_entitled");
  });
});

describe("the documented dev unlock", () => {
  it("clears the lock entirely, so the concierge column renders its thread and composer", async () => {
    vi.stubEnv(DEV_BYPASS_AUTH_FLAG, "1");
    await useAuthStore.getState().refresh();
    expect(lockNow()).toBeNull();
  });

  it("gets there by ENTITLEMENT, not by a credit balance — so it is not a top-up in disguise", () => {
    vi.stubEnv(DEV_BYPASS_AUTH_FLAG, "1");
    return useAuthStore
      .getState()
      .refresh()
      .then(() => {
        // `conciergeAiLockReason` checks entitlement BEFORE credits, so an unentitled account can
        // never be routed to a top-up it cannot use. The bypass has to satisfy the first arm.
        expect(useAuthStore.getState().me?.entitled).toBe(true);
      });
  });
});

describe("the command the locked panel prints is one the reader can actually run", () => {
  it("names DEV_BYPASS_AUTH_FLAG verbatim", () => {
    // The copy is built from the constant, so this pins the shape a reader retypes rather than a
    // second hand-written copy of the key. A rename that misses the doc still fails here.
    expect(CONCIERGE_DEV_UNLOCK_COMMAND).toContain(`${DEV_BYPASS_AUTH_FLAG}=1`);
    expect(CONCIERGE_DEV_UNLOCK_COMMAND).toContain("tauri dev");
  });

  // ══ THE ASSERTION WITH TEETH, AND THE DEFECT IT CAUGHT ═══════════════════════════════════════
  // This panel is read by someone standing wherever they were when the column locked — for an agent
  // that is the REPO ROOT. `tauri` is a script in apps/desktop/package.json ONLY, so the obvious
  // `pnpm tauri dev` resolves in one directory and not the other, and the first draft of this hint
  // printed exactly that. A remedy that only works if you already knew to `cd` first is the
  // dead-instruction failure AGENTS.md records, in the one place built to prevent it.
  //
  // So the property under test is not "the string looks right", it is "this runs from anywhere in
  // the workspace" — which for pnpm means targeting the package explicitly. `--filter` resolves
  // against the workspace root regardless of cwd (verified against the real CLI from both the repo
  // root and apps/desktop); a bare script name does not.
  it("targets the desktop package explicitly, so it does not depend on the reader's cwd", () => {
    expect(CONCIERGE_DEV_UNLOCK_COMMAND).toContain("--filter @sparkle/desktop");
  });

  it("carries no `cd`, which would itself be cwd-dependent", () => {
    // `cd apps/desktop && …` is correct from the root and WRONG from apps/desktop. Either way the
    // hint would be guessing where the reader is; the point is that it does not have to.
    expect(CONCIERGE_DEV_UNLOCK_COMMAND).not.toContain("cd ");
  });

  it("is the command the checked-in doc tells people to run — one string, not two copies", async () => {
    // The panel is the route for someone who never found the doc; the doc is the route for someone
    // who never hit the panel. They are only one remedy if they say the same thing, and a doc is
    // exactly the artefact that silently stops being true. Read from disk so a drifted doc reds.
    //
    // Located by walking UP from cwd rather than from `import.meta.url`: vite rewrites the module
    // URL to a non-`file:` scheme here, so `fs.readFile(new URL(...))` throws
    // "The URL must be of scheme file" — measured, not guessed. Walking up also survives vitest
    // being invoked from the repo root or from the package.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    let dir = process.cwd();
    let docPath = "";
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "docs", "orchestration-live-verification.md");
      try {
        await fs.access(candidate);
        docPath = candidate;
        break;
      } catch {
        dir = path.dirname(dir);
      }
    }
    // An empty path would make the assertion below vacuous, so fail loudly instead.
    expect(docPath, "could not locate docs/orchestration-live-verification.md").not.toBe("");
    const doc = await fs.readFile(docPath, "utf8");
    expect(doc).toContain(CONCIERGE_DEV_UNLOCK_COMMAND);
  });
});
