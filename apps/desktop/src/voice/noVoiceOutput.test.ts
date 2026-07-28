// VOICE OUTPUT STAYS GONE — a merge guard, not a unit test.
//
// Text-to-speech was removed whole in PRD/feat/ui-refresh-2026-07-27 §5: `services/conciergeVoice`
// and `voice/tts/ttsService` were deleted, along with every caller. Voice INPUT is untouched — the
// mic, dictation and the wake word all stay. Sparkle simply never speaks.
//
// The removal is only safe while it stays removed, and the way it comes back is a MERGE, not a
// decision. `main` still carried TTS when §5 landed and had gone on building features through the
// same code, so every sync of main into this line re-offers those call sites — and a resolution
// that takes main's file wholesale reintroduces them in a form that reads as "main's new work".
// Typecheck catches an import of a file that does not exist, but only until someone restores the
// service to fix the build, at which point the feature is back and nothing complains.
//
// So this asserts the absence directly, in the terms a merge conflict is resolved in: no module
// under src/ may name either of those two modules, and neither file may exist.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** The removed modules, as they appear in an import specifier — relative depth stripped, since a
 *  caller anywhere under src/ writes some number of `../` in front of the same tail. */
const REMOVED = ["services/conciergeVoice", "voice/tts/ttsService"] as const;

/** Every .ts/.tsx under src/, EXCLUDING this file (which names the modules on purpose). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && full !== fileURLToPath(import.meta.url)) {
      out.push(full);
    }
  }
  return out;
}

describe("voice output (TTS) is removed and stays removed", () => {
  const files = sourceFiles(SRC);

  it("finds a source tree to scan (the scan itself can't silently cover nothing)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const mod of REMOVED) {
    it(`no module under src/ imports ${mod}`, () => {
      const offenders = files.filter((f) => {
        const text = readFileSync(f, "utf8");
        // Matches `from "../services/conciergeVoice"`, `import("…")` and `vi.mock("…")` alike —
        // a resurrected TEST double is as much a sign the feature is back as a real import.
        return new RegExp(`["'][^"']*${mod}["']`).test(text);
      });
      expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
    });

    it(`${mod} does not exist on disk`, () => {
      expect(existsSync(join(SRC, `${mod}.ts`))).toBe(false);
    });
  }
});
