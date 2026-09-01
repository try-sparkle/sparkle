// ── NO EMOJI AS ICONS ───────────────────────────────────────────────────────────────────────────
//
// A standing founder rule for this codebase: an affordance is a react-icon (Feather, `react-icons/fi`),
// never a character that happens to look like one. `PlanBuildToggle` already carries the note at its
// call site — "a react-icon, not the ⚒ character it replaced".
//
// It is not a style preference. A dingbat is a FONT decision: `✕` `▾` `✓` `↺` `›` resolve through
// whatever face the element inherits, so they change weight, baseline and optical size between
// macOS and Windows and between the UI face and mono — and this branch just moved the whole app off
// IBM Plex onto `system-ui`, which is exactly the kind of change that silently reshapes them. A
// react-icon is geometry: same 24-unit grid, same 2px stroke, aligned by `size`, everywhere.
//
// WHAT IS NOT AN ICON, and stays legal:
//   • KEY SYMBOLS — `⌘` `⌃` `⇧` `⌥`. These are the names of the keys. Feather has no glyph for them
//     and substituting words ("Cmd") is a worse label, not a better one.
//   • ARROWS AND SEPARATORS INSIDE PROSE — "Settings → Developer", "off → paused". That is
//     punctuation in a sentence, not a control.
//   • The `✦` AI-enhancements MARK (AiEnhancementsBadge, ConciergeToolsPane). Feather has no
//     sparkle, so there is nothing to port it to; changing it to `FiStar` would be a brand edit
//     dressed as a lint fix. Recorded as a founder call in
//     `PRD/sparkle/blueprint-type-scale.md` rather than guessed at here.
//
// A RATCHET, like the other guards on this branch: the remaining hits are in files other branches
// own (Workspace, AgentSidebar, AgentPane, AgentRow), so a hard zero would red the fleet for work in
// flight. Lower the ceiling in the PR that lowers reality — and add the file you emptied to `SWEPT`,
// because a ceiling alone lets the next branch put a glyph back there and pay for it elsewhere.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    // BOTH .ts AND .tsx (roborev 54772), for the reason theme/scale.test.ts already records:
    // hoisting a glyph out of a component into a helper must not lower the count.
    //
    // `.fixture.` is excluded alongside `.test.`: a fixture is CAPTURED DATA, not an affordance.
    // `engine/capturedScreens.fixture.ts` holds Claude Code 2.1.220 terminal screens recorded
    // byte-for-byte through a real PTY and replayed through a headless xterm — its `❯`, `⏺` and `⎿`
    // ARE what the terminal draws, and the whole point of the file is that they match verbatim.
    // "Port them to react-icons" is not a possible fix there; changing them would silently break the
    // screen-classifier tests that exist to catch upstream drift. Scanning it would also make this
    // ratchet unfixable-by-construction — the count could only be lowered by corrupting the data.
    else if (/\.tsx?$/.test(name) && !name.includes(".test.") && !name.includes(".fixture."))
      out.push(p);
  }
  return out;
}

// A scan that silently matched NOTHING would make every ceiling in this file vacuous. The ratchets
// below all gate on `hits.length <= CEILING`, and zero satisfies that — forever, silently, over a
// tree nobody opened. That is not hypothetical here: every agent worktree on this machine lives
// under a path containing a space ("Application Support"), so a walk rooted on a
// `new URL(..).pathname` reads a percent-encoded directory that does not exist. The
// `fileURLToPath` above is what keeps SRC honest; this floor is what notices if anything ever
// stops being honest.
//
// It THROWS rather than returning an empty list, so the vacuity is impossible rather than merely
// detectable: one broken walk reds every ratchet that depends on it, not just whichever single
// test happens to carry the assertion. Compare `modalChrome.test.ts`, which anchors its own
// narrower scope the same way.
const MIN_SCANNED_FILES = 200;

function scannedSourceFiles(): string[] {
  const files = sourceFiles(SRC);
  if (files.length < MIN_SCANNED_FILES) {
    throw new Error(
      `the source scan under ${SRC} found ${files.length} file(s), below the floor of ` +
        `${MIN_SCANNED_FILES}. The ratchets in this file gate on a COUNT, so a truncated or empty ` +
        `scan reports GREEN while guarding nothing. Fix the walk — do not lower this floor.`,
    );
  }
  return files;
}

/**
 * Glyphs that stand in for an ICON: geometric shapes, dingbats, arrows-as-ornaments, enclosed
 * alphanumerics and the pictographic planes.
 *
 * Expressed as a broad sweep MINUS a named exempt set rather than as hand-tuned codepoint ranges,
 * because the ranges are where this goes wrong: the first cut wrote `←-↓` meaning "arrow ornaments"
 * and swallowed `→` (U+2192) sitting in the middle of it, then wrote `⌉-⏿` and swallowed `⌘`
 * (U+2318). Both are on the legal list four lines above their own exclusion. A visible set of
 * characters you can read is checkable; a range boundary is not.
 */
// U+FE0F, the emoji variation selector, is deliberately NOT in the class: eslint's
// `no-misleading-character-class` rejects a combining mark inside one, and it would buy nothing \u2014
// it never appears without a base character the ranges already catch.
//
// THREE BLOCKS THE FIRST CUT MISSED, each holding a glyph THIS BRANCH ITSELF REMOVED, so neither
// the ceiling nor the swept-surface test could see it come back (roborev 54772):
//   \u2022 U+00D7 MULTIPLICATION SIGN is Latin-1 \u2014 the close affordance, and TWO were still live;
//   \u2022 U+2039-U+203B is General Punctuation \u2014 PinnedPrompt's single-chevron crumb separator;
//   \u2022 U+2440-U+244A is the OCR block \u2014 OpenPrMenu's git-branch mark.
// The note above argues that RANGES are where this goes wrong, and it was right about the mechanism
// while being wrong about the direction: the named exempt set narrows false POSITIVES, and every
// one of these was a false NEGATIVE. Both halves of a filter need the same scepticism.
const ICON_RANGE = /[\u2190-\u21FF\u2300-\u23FF\u25A0-\u25FF\u2600-\u27BF\u2B00-\u2BFF\u24B6-\u24EA]|[\u{1F000}-\u{1FAFF}]/u;

/**
 * Characters that are an icon in ONE POSITION and ordinary text in every other.
 *
 * `\u00D7` is the close button — and it is also the multiplication sign, which SpendPane writes in a
 * sentence ("billed at 0.1x the input rate") and HelperIsland writes in a dimension ("850x188").
 * `\u00AB\u00BB` are close-button chevrons and also the quote marks `logSafePaths` builds its
 * `<<path>>` placeholder from, and a bracket in a terminal-prompt REGEX in `heuristics.ts`.
 *
 * Adding them to `ICON_RANGE` outright — which is what the review suggested — turned six pieces of
 * ordinary prose into violations. The distinction that actually separates them is POSITION, not
 * identity: a close button is written as a bare JSX child, alone on its line. Prose never is. So
 * these count only there, which catches every real one (ImageLightbox, TextPill, AttachmentTile,
 * TextPillModal all matched) and none of the false ones.
 */
const AMBIGUOUS = new Set([..."\u00D7\u00AB\u00BB\u2039\u203A\u203B\u2442"]);

/**
 * Legal anywhere: key names, prose punctuation, and the one mark Feather cannot express.
 *
 * The KEY NAMES run past the modifiers: `\u2191\u2193\u21A9` name the arrow and return keys in "\u2191\u2193 navigate \u00B7 \u21A9
 * jump" and "Send (\u2318\u21A9)", which is the same category as `\u2318` \u2014 the glyph IS what is printed on the
 * key, and "Up/Down arrow, Return" is a worse label, not a more correct one.
 */
const EXEMPT = new Set([
  ..."\u2318\u2303\u21E7\u2325\u23CE\u232B\u21A9\u2191\u2193", // key names
  // Prose arrows and the separator. `\u21C4` joins the two halves of a shortcut's NAME
  // ("Composer \u21C4 Terminal" in keybindingsStore) \u2014 it reads as the word "between", not as a control.
  ..."\u2190\u2192\u2194\u2195\u21C4\u00B7",
  "\u2726", // the AI-enhancements mark
]);

function isIconGlyph(ch: string): boolean {
  return !EXEMPT.has(ch) && ICON_RANGE.test(ch);
}

/**
 * A glyph inside a REGEX LITERAL is being MATCHED, not rendered — and what it matches is another
 * program's output. `engine/statusEngine.ts` and `composerOcclusion.ts` detect Claude Code's spinner
 * (`/^[✻✽✢✶✳·*∗]\s/`); `screenClassifier.ts`, `approvalClassifier.ts` and `heuristics.ts` detect
 * its selection cursor and option lines (`[❯›>]`). These are the exact inverse of the rule: the app
 * cannot choose the character, because Claude Code prints it. Substituting a react-icon would not
 * make the UI nicer, it would break the parser.
 *
 * Matched structurally rather than by a path list, because the property that makes them legal is
 * visible in the line itself and stays true for the next parser someone writes.
 */
function isRegexLiteral(trimmed: string): boolean {
  return /=\s*\/\^?[^=]*\/[gimsuy]*[;,)]?\s*$/.test(trimmed);
}

/** A line whose entire content is one glyph — how every close button in this codebase is written. */
function isBareGlyphChild(trimmed: string): boolean {
  return trimmed.length > 0 && [...trimmed].every((c) => AMBIGUOUS.has(c));
}

/**
 * `composer/attachments.ts` is exempt BY PATH rather than absorbed into the ceiling. Its
 * `buildDisplay` renders emoji count markers into the composer's transcript string, and that is a
 * DECISION ALREADY TAKEN under earlier review, not drift: `services/conciergeAttach.ts` documents
 * it at its own call site — the concierge deliberately does NOT use `buildDisplay` because of the
 * emoji (roborev 46911), while "buildDisplay keeps its glyphs for the Sparkle-pane Composer".
 * Quietly folding a settled call into a number re-litigates it without saying so.
 */
const GLYPH_EXEMPT = new Set([
  "components/composer/attachments.ts",
  // `services/agentNaming.ts` only exists downstream of the line above: its regex strips the very
  // display suffix `buildDisplay` produces, so it must name the same emoji. Exempting the producer
  // and flagging the consumer would be incoherent.
  "services/agentNaming.ts",
  // `engine/attention.ts`'s RED_CIRCLE prefixes a PUSH NOTIFICATION title. That is an OS text
  // channel — there is no DOM, so there is no react-icon to reach for. Same category as the key
  // names above: the glyph is the only way to say it.
  "engine/attention.ts",
  // `engine/claudeCodeScreen.ts` MATCHES glyphs, it never renders one. Its patterns recognise the
  // bytes Claude Code paints into a PTY — the `⏺`/`⎿` gutter markers that open a tool call and its
  // result — so that the write-guard can tell a busy Claude Code from `vim` (bead sparkle-v7k3y).
  //
  // Squarely the `engine/attention.ts` category, one step further out: there is not merely no DOM,
  // there is no output at all. A react-icon cannot match text on a terminal screen, and swapping
  // the codepoint for anything else would simply stop the matcher working. The scanner's existing
  // `isRegexLiteral` escape hatch covers a line that IS a bare regex but not a `const` holding an
  // array of them, which is the only reason this file surfaces at all.
  "engine/claudeCodeScreen.ts",
  // `services/promptTextNormalize.ts` is the same category as the line above, and arrived by the
  // same route. Its `VOLATILE_SPAN` names the braille/ASCII spinner codepoints so it can STRIP them
  // out of a captured terminal screen — `⠋⠙⠹…◐◓◑◒` are bytes another program painted into a PTY, and
  // matching them is the entire point. There is no DOM and no output; a react-icon cannot match text
  // on a terminal, and changing the codepoints would simply stop the matcher working.
  //
  // It surfaces here only because the regex is too long to fit on one line, so the scanner's
  // `isRegexLiteral` escape hatch — which needs the `= /…/g;` on a single line — does not fire. That
  // is a formatting accident, not a fact about the code: the identical regex lived unflagged in
  // `services/pickerFingerprint.ts` purely because it fit. Naming the file states the exemption
  // deliberately instead of leaving it hostage to prettier's print width.
  "services/promptTextNormalize.ts",
]);

function hits(): string[] {
  const out: string[] = [];
  for (const file of scannedSourceFiles()) {
    if (GLYPH_EXEMPT.has(file.slice(SRC.length))) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      // Comments explain these glyphs by quoting them; a scanner that flags its own documentation
      // is a scanner nobody keeps. Same rule as theme/svgTokens.test.ts — but a LEADING-marker test
      // is not enough here, because the two hits it missed were a TRAILING `// …the final ✓…` and a
      // JSX comment's closing `…Refill or ✕. */}` line. Strip trailing comment text as well.
      const code = line
        // NOT a bare `//`: that truncates at a URL inside a string literal and silently drops
        // the rest of the line from the scan (roborev 54772). A comment marker is never
        // preceded by a colon; a URL scheme always is.
        .replace(/(^|[^:])\/\/.*$/, "$1")
        .replace(/\{?\/\*[\s\S]*?(\*\/\}?|$)/, "")
        .replace(/^[^{]*\*\/\}?/, (m) => (line.includes("/*") ? m : ""));
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
      const trimmed = code.trim();
      if (isRegexLiteral(trimmed)) return;
      if ([...code].some(isIconGlyph) || isBareGlyphChild(trimmed)) {
        out.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return out;
}

/** Reality when this branch swept its surfaces. Every survivor is in a file another branch owns. */
// Lowered 6 -> 4 by the terminal stopped-state PR (sparkle-l2xgf), which ported this file's four
// sites — the stopped-footer square, its Restart, the failure overlay's Start again, and the
// copy confirmation — to react-icons/fi. Per the ratchet's own rule: lower the ceiling in the PR
// that lowers reality, so the ground reclaimed here cannot be quietly given back.
const MAX_GLYPH_ICONS = 4;

describe("affordances are react-icons, never characters", () => {
  it("the count of glyph-as-icon sites never rises", () => {
    const found = hits();
    expect(
      found.length,
      `${found.length} glyph-as-icon sites vs ceiling ${MAX_GLYPH_ICONS}. Use react-icons/fi:\n` +
        found.join("\n"),
    ).toBeLessThanOrEqual(MAX_GLYPH_ICONS);
  });

  // The half a ceiling cannot say: the surfaces this branch swept must STAY swept. Without this a
  // branch could put `✕` back in BoardView and pay for it by removing one from Terminal.
  it("the swept surfaces carry no glyph icons at all", () => {
    const SWEPT = [
      "capture/CaptureApp.tsx",
      "components/BoardView.tsx",
      "components/ModelPill.tsx",
      "components/Composer.tsx",
      "components/PinnedPrompt.tsx",
      "components/SparkleConsentBanner.tsx",
      "components/SettingCheckbox.tsx",
      "components/AccountsScreen.tsx",
      "components/KeyboardShortcutsMenu.tsx",
      "components/HistorySearch.tsx",
      // The four the hand-written list dropped, each cleaned by this branch (roborev 54772).
      // `AttachmentTile` is the worked example: named as swept in the commit message, absent
      // here, and still carrying a close glyph the range could not see either — two independent
      // holes conspiring to hide one live offender.
      "components/OpenPrMenu.tsx",
      "components/composer/AttachmentTile.tsx",
      "components/composer/TextPill.tsx",
      "components/composer/TextPillModal.tsx",
      "satellite/SatelliteApp.tsx",
      // Emptied by the terminal stopped-state PR (sparkle-l2xgf). Lowering the ceiling 6 -> 4 was
      // only half of it: `toBeLessThanOrEqual` would still let a branch reintroduce a glyph here
      // and pay for it by removing one from Workspace, which is the precise trade this second test
      // exists to forbid. Its surviving `→ ⇧ ⌘ ⌥` are all in `EXEMPT`, so this is a true zero.
      "components/Terminal.tsx",
    ];
    const offenders = hits().filter((h) => SWEPT.some((s) => h.startsWith(s + ":")));
    expect(offenders, "a glyph icon came back to a swept surface:\n" + offenders.join("\n")).toEqual([]);
  });
});
