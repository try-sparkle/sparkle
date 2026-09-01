// The label treatment is the direction's signature mark, and it drifted apart once already — about
// twenty hand-typed near-copies with five different letter-spacings. These assertions are what stop
// it happening again: the FIRST two pin the treatments to the spec's numbers, and the THIRD is the
// one that matters most, because it says the call sites still use them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FONT_MONO, RADIUS, TYPE } from "../theme/scale";
import {
  UNATTRIBUTED_LABEL,
  attributeSites,
  attributedGuardReport,
  blameInvocationCount,
  blameSite,
  resetBlameInvocationCount,
  type GuardSite,
} from "../theme/scaleGuardTestUtils";
import { CHIP, COUNT, SECTION_LABEL, TAG, chip, tag } from "./labelTreatment";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * Hand-typed label tracking: a NUMERIC `letterSpacing` in the label range.
 *
 * The twenty near-copies this file exists to retire used 0.3, 0.4, 0.5, 0.6, 0.8 and 1 — all of them
 * one person's guess at "tracked a bit". Two numeric spacings are NOT that and stay legal, which is
 * why the range is bounded at both ends rather than being "any number":
 *   • `letterSpacing: 0` is UNDOING inherited tracking (a count inside a labelled header is handed
 *     the label's 0.1em unless it says otherwise) — a reset, not a label;
 *   • `letterSpacing: 12` is MobileDevicesPane's pairing code, a display treatment that spaces
 *     digits apart to be read aloud. Nothing about it is a section label.
 *
 * The terminator is `[,\n}]` and the match is global (roborev 54739): requiring a trailing comma
 * exempted the property written LAST in an object literal, and `line.match` stopped at the first
 * hit on a line.
 */
function handTypedTracking(src: string, rel: string): GuardSite[] {
  const out: GuardSite[] = [];
  src.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
    for (const m of line.matchAll(/letterSpacing:\s*([\d.]+)\s*(?=[,\n}]|$)/g)) {
      const px = Number(m[1]);
      // A SITE, not a formatted string: attribution costs a `git` process each, so who wrote this
      // line is resolved LAZILY, only while a failure message is being built. The detection above
      // is unchanged — this carries the same three facts the old string interpolated.
      if (px > 0 && px < 2) out.push({ file: rel, line: i + 1, text: line.trim() });
    }
  });
  return out;
}

/** Every `.ts`/`.tsx` source file under `dir`, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

/** Every hand-typed tracking site in the whole tree — the ratchet's real scan, in one place. */
function trackingSitesTreeWide(): GuardSite[] {
  return sourceFiles(SRC).flatMap((f) =>
    handTypedTracking(readFileSync(f, "utf8"), f.slice(SRC.length)),
  );
}

describe("the section label matches the spec's .grp / .rail b", () => {
  it("is mono, uppercase, tracked 0.1em, at the micro step", () => {
    // `.grp { font: 500 var(--t-micro)/1 var(--k-mono); letter-spacing: .1em;
    //         text-transform: uppercase; color: var(--k-faint) }`
    expect(SECTION_LABEL.fontFamily).toBe(FONT_MONO);
    expect(SECTION_LABEL.fontSize).toBe(TYPE.micro);
    expect(SECTION_LABEL.letterSpacing).toBe("0.1em");
    expect(SECTION_LABEL.textTransform).toBe("uppercase");
    // The ink is a real token, not a hex someone eyeballed against the panel.
    expect(String(SECTION_LABEL.color)).toMatch(/^var\(--c-/);
  });
});

describe("chips and counts are near-square and tabular", () => {
  it("a chip uses --r-sm, never a capsule", () => {
    expect(CHIP.borderRadius).toBe(RADIUS.sm);
    expect(CHIP.borderRadius).not.toBe(999);
  });

  it("chips and counts are mono with TABULAR figures, so a changing count cannot jitter", () => {
    // The whole point: these carry numbers that tick while you watch. Proportional figures make the
    // chip resize on every tick and shuffle its neighbours.
    for (const [name, style] of [["CHIP", CHIP], ["COUNT", COUNT]] as const) {
      expect(style.fontFamily, `${name} is not mono`).toBe(FONT_MONO);
      expect(style.fontVariantNumeric, `${name} figures are not tabular`).toBe("tabular-nums");
      expect(style.fontSize, `${name} is off the type scale`).toBe(TYPE.micro);
    }
  });

  it("TAG keeps the casing and tracking whose loss was the regression", () => {
    // Three field-name tags — AccountsScreen's `default`, MobileDevicesPane's `This Mac`,
    // SpendPane's `unpriced` — silently began rendering in source casing when the first cut of
    // CHIP dropped these. Pinned so the next sweep cannot drop them again (roborev 54739).
    expect(TAG.textTransform).toBe("uppercase");
    expect(TAG.letterSpacing).toBe("0.1em");
    expect(TAG.fontWeight).toBe(CHIP.fontWeight);
    expect(CHIP.fontWeight, "a chip that inherits its weight is a chip that changes with its parent").toBeTruthy();
  });

  it("COUNT undoes the tracking and casing it inherits from a label container", () => {
    // A count sits inside a SECTION_LABEL header, so CSS hands it 0.1em and uppercase. A tracked
    // number reads as a code, not a quantity — and this belongs to the treatment, not to whichever
    // call site happens to remember.
    expect(COUNT.letterSpacing).toBe(0);
    expect(COUNT.textTransform).toBe("none");
  });

  it("`chip(ink)` paints the ink as BOTH text and edge — the spec draws these", () => {
    const c = chip("var(--c-amber)");
    expect(c.color).toBe("var(--c-amber)");
    expect(c.border).toBe("1px solid var(--c-amber)");
    expect(c.borderRadius).toBe(RADIUS.sm);
    const t = tag("var(--c-amber)");
    expect(t.color).toBe("var(--c-amber)");
    expect(t.border).toBe("1px solid var(--c-amber)");
    expect(t.textTransform).toBe("uppercase");
  });
});

describe("the call sites actually use the treatment", () => {
  // A shared constant nobody imports is worse than no constant: it reads as done. This checks the
  // surfaces this branch migrated still spread it rather than re-typing the properties inline.
  const MIGRATED = [
    "components/StageSectionHeader.tsx",
    "components/StageColumnHeader.tsx",
    "components/CreditsPanel.tsx",
    "components/ToolsPane.tsx",
    "components/SpendPane.tsx",
    "components/CloudAuthPane.tsx",
    "components/MobileDevicesPane.tsx",
    "components/KeyboardShortcutsMenu.tsx",
    "components/OnePasswordPane.tsx",
    "components/CardCriteria.tsx",
    "components/SelectionPopup.tsx",
    // Migrated on other branches, and left OUT of this list by both of them — which is the gap
    // roborev caught: the tree-wide ratchet below only holds while its ceiling exactly equals the
    // count, so a later migration that lowers the count without lowering the ceiling hands these
    // two files a free slot to silently re-drift into. A per-file entry costs nothing and pins
    // them at exact zero regardless of what the ceiling is doing.
    "components/ConciergeResearchPane.tsx",
    "components/Concierge/PipelineHealthChip.tsx",
  ];

  it.each(MIGRATED)("%s spreads SECTION_LABEL", (rel) => {
    expect(readFileSync(join(SRC, rel), "utf8")).toContain("...SECTION_LABEL");
  });

  it.each(MIGRATED)("%s does not re-type label tracking by hand", (rel) => {
    const sites = handTypedTracking(readFileSync(join(SRC, rel), "utf8"), rel);
    expect(
      sites,
      // Built only when there IS something to report — `expect(actual, message)` evaluates its
      // message eagerly, so an unguarded call would blame on every green run.
      sites.length === 0
        ? ""
        : attributedGuardReport({
            root: SRC,
            headline: `${rel} re-types label tracking by hand at ${sites.length} site(s).`,
            remedy: `Spread SECTION_LABEL (or TAG) instead of writing the tracking out; the ` +
              `treatment owns 0.1em so a call site cannot drift from it.`,
            sites,
          }),
    ).toEqual([]);
  });
});

describe("nothing in the tree reaches for a capsule where the spec draws a box", () => {
  // A RATCHET, like theme/scale.test.ts and fontTokens.test.ts, and for the same reason: the
  // remaining `999`s live in files other branches own, so a hard zero here would red the fleet for
  // work that is in flight. `PILL` stays legal in scale.ts for the shapes that genuinely need it —
  // a status DOT is a circle, which is not a radius decision — so this counts the LITERAL, which is
  // always someone reaching past the scale rather than naming the shape.
  // 8 -> 5, LOWERED with the cleanup that produced it, because a ceiling left above the real count
  // is slack rather than a gate: the three free slots would have let the very defect just fixed
  // (`NudgeCard` / `ApprovalPrompt`'s action buttons drawn as stadium pills) reappear in a third
  // component silently — and `Concierge/buttonRadius.test.tsx` only renders those two, so nothing
  // else would have caught it. The five that remain are AgentSidebar's close affordance,
  // ConciergeColumn's credit backdrop and PresenceSlider's three slider parts; each is recorded as
  // deliberate in that test's header. A ratchet only ratchets if it is re-tightened when it can be.
  const MAX_LITERAL_999 = 5;

  // The SAME shape, for the same reason, over the same tree. The first cut of the tracking guard
  // iterated only the eleven files it had just cleaned, so it passed VACUOUSLY — it could fire only
  // on re-drift inside those eleven, while new drift lands in new or untouched files where it was
  // invisible. There were already 14 such sites when it shipped (roborev 54739).
  // 8 -> 9, and a RISING ratchet needs its reason in the file rather than in a commit message.
  // `HintOverlay`'s keyboard chiclet went to `0.1em` in this branch and came back to `0.5` under
  // review (roborev 54788): it is 700-weight at `TYPE.small` where the label treatment is
  // `WEIGHT.med` at `TYPE.micro`, so it is not the label register, and React appends `px` to a
  // number — `0.1em` there was 1.2px, a 2.4x increase that also un-centred a one-character badge,
  // because CSS emits tracking after the last glyph and `BADGE_PAD_X` is symmetric.
  //
  // So this is a REVIEWED RESTORATION, not new sprawl. The distinction is exactly what a ratchet
  // cannot make on its own, which is why it is written down here instead of quietly hidden from the
  // scanner by hoisting the 0.5 into a named constant — that trick is the one three earlier rounds
  // on this branch were spent closing.
  //
  // 9 -> 8. `ConciergeResearchPane` shipped with TWO hand-typed 0.3 sites, which pushed the count to
  // 10 and reddened this ratchet on every unrelated PR until they were migrated. Both were exact
  // hand-copies of the treatment — mono, `TYPE.micro`, uppercase, `C.muted` — so they became
  // `SECTION_LABEL` spreads and the count fell to 8. A ratchet that is not tightened after a
  // migration hands the next drift a free slot, which is the whole failure mode this number exists
  // to prevent, so it falls with the count rather than being left at the old ceiling.
  const MAX_HAND_TYPED_TRACKING = 8;

  it("the count of hand-typed label tracking never rises, tree-wide", () => {
    resetBlameInvocationCount();
    const sites = trackingSitesTreeWide();
    expect(
      sites.length,
      // ONE feature commit reddens this, and CI then reports it against whichever unrelated branch
      // runs next — so the list names the introducing commit for every site and puts the NEWEST at
      // the top, which is where the entry this branch added will be. Built only on the failing
      // path: `expect(actual, message)` evaluates its message eagerly, and this scans the tree.
      sites.length <= MAX_HAND_TYPED_TRACKING
        ? ""
        : attributedGuardReport({
            root: SRC,
            headline:
              `${sites.length} hand-typed label tracking sites vs ceiling ` +
              `${MAX_HAND_TYPED_TRACKING} — ${sites.length - MAX_HAND_TYPED_TRACKING} too many.`,
            remedy:
              `Spread SECTION_LABEL / TAG (0.1em) at the newest site above instead of hand-typing ` +
              `the tracking. If you MIGRATED sites rather than adding one, lower ` +
              `MAX_HAND_TYPED_TRACKING to ${sites.length} in this PR — a ceiling left above the ` +
              `real count is a free slot for the next drift.`,
            sites,
          }),
    ).toBeLessThanOrEqual(MAX_HAND_TYPED_TRACKING);
    // HERMETICITY, pinned rather than promised: attribution shells out to `git`, and this scan
    // walks the whole tree. A green run must spawn ZERO processes — move the blame into the
    // scanner and this line goes red.
    expect(
      blameInvocationCount(),
      "a GREEN ratchet run spawned git processes — attribution must stay on the failing path only",
    ).toBe(0);
  });

  it("the count of literal `borderRadius: 999` never rises", () => {
    resetBlameInvocationCount();
    const sites: GuardSite[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        if (/borderRadius:\s*999\b/.test(line)) {
          sites.push({ file: file.slice(SRC.length), line: i + 1, text: line.trim() });
        }
      });
    }
    expect(
      sites.length,
      sites.length <= MAX_LITERAL_999
        ? ""
        : attributedGuardReport({
            root: SRC,
            headline:
              `${sites.length} literal 999 radii vs ceiling ${MAX_LITERAL_999} — ` +
              `${sites.length - MAX_LITERAL_999} too many.`,
            remedy:
              `Use RADIUS.sm for a chip at the newest site above, or PILL from theme/scale if the ` +
              `shape really is a circle or a capsule. If you MIGRATED sites, lower ` +
              `MAX_LITERAL_999 to ${sites.length} in this PR.`,
            sites,
          }),
    ).toBeLessThanOrEqual(MAX_LITERAL_999);
    expect(
      blameInvocationCount(),
      "a GREEN ratchet run spawned git processes — attribution must stay on the failing path only",
    ).toBe(0);
  });
});

describe("a tripped ratchet names the commit behind every site it lists", () => {
  // THE READING PROBLEM THIS GUARDS. One feature commit pushes the count over the ceiling, and CI
  // reports it against whichever unrelated branch runs next. The old message listed every CURRENT
  // hit and marked none as new, so the agent had to diff the list by hand against this constant's
  // comment history to find the one line its own branch added.
  //
  // Deliberately fed by the REAL scan over the REAL tree, not a hand-built array: a test that
  // formats a hand-made list proves the formatter works and says nothing about whether the ratchet
  // feeds it. If the scan and the report ever stop agreeing on a shape, this is what goes red.
  const sites = trackingSitesTreeWide();

  it("has real sites to attribute — otherwise everything below is vacuous", () => {
    expect(
      sites.length,
      "the tree-wide scan found nothing, so the attribution assertions below prove nothing",
    ).toBeGreaterThan(0);
  });

  it("orders them NEWEST COMMIT FIRST, so the entry this branch added is on top", () => {
    const times = attributeSites(SRC, sites).map((s) => s.blame.time);
    expect(times, "the offender list is not sorted newest-commit-first").toEqual(
      [...times].sort((a, b) => b - a),
    );
  });

  it("spends the failure message on sha, date, author, file:line and the offending text", () => {
    const attributed = attributeSites(SRC, sites);
    const message = attributedGuardReport({
      root: SRC,
      headline: `${sites.length} hand-typed label tracking sites vs ceiling 0.`,
      remedy: "Spread SECTION_LABEL / TAG (0.1em) instead.",
      sites,
    });

    expect(message).toContain("NEWEST COMMIT FIRST");
    expect(message).toContain("Spread SECTION_LABEL / TAG (0.1em) instead.");
    for (const s of attributed) {
      expect(message, `${s.file}:${s.line} is missing from the report`).toContain(
        `${s.file}:${s.line}`,
      );
      expect(message, `${s.file}:${s.line} carries no attribution column`).toContain(
        s.blame.label || UNATTRIBUTED_LABEL,
      );
      expect(message, `${s.file}:${s.line} lost its offending text`).toContain(s.text);
    }

    // The rendered ORDER matches the sorted order — a sorted array printed in scan order would
    // still bury the new entry, which is the defect this exists to fix.
    const first = attributed[0]!;
    const last = attributed[attributed.length - 1]!;
    if (first !== last) {
      expect(message.indexOf(`${first.file}:${first.line}`)).toBeLessThan(
        message.indexOf(`${last.file}:${last.line}`),
      );
    }

    // We ARE in a git checkout, so at least one site must really carry a sha. Guarded by a control
    // blame rather than assumed: outside a repo the contract is to degrade, not to fail.
    if (blameSite(join(SRC, "theme/scale.ts"), 1).known) {
      expect(
        attributed.some((s) => s.blame.sha !== "" || s.blame.uncommitted),
        "not one site was attributed inside a real git checkout",
      ).toBe(true);
    }
  });
});
