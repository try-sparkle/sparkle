// The genie must never speak — bead sparkle-uz87.5.
//
// Text-to-speech was DELIBERATELY REMOVED from this product (commit f24324e6b). The overlay's
// `speaking` mode is a VISUAL state; nothing in the response pipeline may turn it into audio. A
// comment saying so has never stopped anyone, so this reads the directory's own source and fails if
// an audio API appears in it — the same shape as the repo's other source-pinning guards.
//
// It scans SOURCE only (`*.test.ts` excluded), because a test naming the forbidden identifiers is
// how the guard describes what it forbids.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `fileURLToPath`, not `new URL(…).pathname`: this repo's worktrees live under a path containing a
// space ("Application Support"), which `.pathname` percent-encodes into a directory that does not
// exist. The scan then throws ENOENT — visibly, because of the file-list assertion below, but a
// scan written to tolerate a missing directory would have passed forever instead.
const DIR = fileURLToPath(new URL(".", import.meta.url));

/** Runtime handles that can produce sound. Identifiers, not prose — the files' own comments
 *  discuss speech at length and must not trip this. */
const AUDIO_APIS: ReadonlyArray<[string, RegExp]> = [
  ["speechSynthesis", /\bspeechSynthesis\b/],
  ["SpeechSynthesisUtterance", /\bSpeechSynthesisUtterance\b/],
  ["AudioContext", /\bAudioContext\b/],
  ["new Audio(", /\bnew Audio\s*\(/],
  [".speak(", /\.speak\s*\(/],
  [".play(", /\.play\s*\(/],
  ["ElevenLabs / tts endpoints", /\b(?:elevenlabs|text_to_speech|textToSpeech)\b/i],
];

function sourceFiles(): Array<{ name: string; text: string }> {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }));
}

describe("the genie response engine never speaks", () => {
  it("finds the source files it is meant to be guarding", () => {
    // Without this the scan below is vacuous: an empty file list passes every assertion.
    const names = sourceFiles().map((f) => f.name).sort();
    expect(names).toEqual(["classify.ts", "handlers.ts", "index.ts", "router.ts", "types.ts"]);
  });

  it.each(AUDIO_APIS)("references no %s", (_label, pattern) => {
    const offenders = sourceFiles()
      .filter((f) => pattern.test(f.text))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it("would actually catch one — the guard can fail", () => {
    // Pins the patterns against a synthetic file, so a regex that stopped matching anything (and
    // would therefore pass forever) is caught here rather than in production.
    const planted = 'const u = new SpeechSynthesisUtterance("hi"); window.speechSynthesis.speak(u);';
    const caught = AUDIO_APIS.filter(([, pattern]) => pattern.test(planted)).map(([label]) => label);
    expect(caught).toContain("speechSynthesis");
    expect(caught).toContain("SpeechSynthesisUtterance");
    expect(caught).toContain(".speak(");
  });
});
