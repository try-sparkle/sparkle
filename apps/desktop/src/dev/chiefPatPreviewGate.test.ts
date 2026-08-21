// THE SECURITY PROPERTY BEHIND `[preview]`'s `--mode preview` FLAG, tested where it is ENFORCED.
//
// `.sparkle/config.toml` points the agent-facing preview server at this package's vite dev server.
// Under the default mode, `devChiefPat` resolves `CHIEF_API` from the monorepo root `.env.local` —
// which Sparkle COPIES INTO EVERY AGENT WORKTREE — and `define`s it into the bundle the dev server
// SERVES. That was measured, not theorised: the 36-character token appeared verbatim in the JS
// served from the preview port, on a loopback url the concierge card invites the reader to open in
// their real browser.
//
// WHY THIS FILE EXISTS RATHER THAN THE GREP THAT ALREADY GUARDS IT. The config test pins the
// literal `"--mode", "preview"` in an argv array; the ENFORCEMENT is `devChiefPat`'s
// `if (mode !== "development") return ""`. That gate is exactly the line someone "corrects" later —
// keying it on `command === "serve"` is a tempting and plausible edit, and the config comment walks
// through that very reasoning — and the whole repo stays green while the token returns to the
// served JS. `vite.config.ts` already carries a hard gate for the BUILD path; dev-serve, which is
// the path the preview tool actually uses, had none.
//
// BOTH DIRECTIONS ARE ASSERTED ON PURPOSE. "preview mode omits the token" alone passes for a gate
// that is inert — one that omits the token in every mode, including the developer's own `pnpm dev`,
// where the injection is a wanted feature. The pair is what pins the gate to `mode` specifically.
// NOT named vite.config.*.test.ts: vitest's default exclude carries **/{...,vite,...}.config.*,
// which swallows any such file and reports "No test files found" rather than running it.
import { describe, it, expect } from "vitest";
import config from "../../vite.config";

const KEY = "import.meta.env.VITE_CHIEF_PAT";
const TOKEN = "test-chief-pat-not-a-real-credential";

/** `defineConfig` is identity for the function form, so the export is callable. */
async function defineFor(mode: string, command: "serve" | "build") {
  const prev = process.env.CHIEF_API;
  process.env.CHIEF_API = TOKEN;
  try {
    const resolved = await (
      config as unknown as (
        env: { mode: string; command: "serve" | "build"; isSsrBuild: boolean; isPreview: boolean },
      ) => Promise<{ define: Record<string, string> }> | { define: Record<string, string> }
    )({ mode, command, isSsrBuild: false, isPreview: false });
    return resolved.define;
  } finally {
    if (prev === undefined) delete process.env.CHIEF_API;
    else process.env.CHIEF_API = prev;
  }
}

describe("the Chief PAT never reaches what the PREVIEW serves", () => {
  it("mode 'preview' defines an EMPTY token even with CHIEF_API set in the environment", async () => {
    const define = await defineFor("preview", "serve");
    // JSON.stringify("") — the literal the bundle gets.
    expect(define[KEY]).toBe('""');
    expect(define[KEY]).not.toContain(TOKEN);
  });

  it("mode 'development' STILL injects it — so the gate is keyed to mode, not inert", async () => {
    // The other direction. Without this, a gate that returned "" unconditionally would pass the
    // test above while silently removing a feature the founder relies on in his own `pnpm dev`.
    const define = await defineFor("development", "serve");
    expect(define[KEY]).toBe(JSON.stringify(TOKEN));
  });

  it("the BUILD path still refuses outright, in any mode that resolves a token", async () => {
    // Unchanged behaviour, pinned so the dev-serve gate above cannot be "simplified" by folding the
    // two rules together and losing the build refusal.
    await expect(defineFor("development", "build")).rejects.toThrow(/Refusing to build/);
  });
});
