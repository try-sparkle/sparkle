// THE SHORTCUTS COPY IS A PROMISE — and it must not promise a surface that no longer exists.
//
// `SHORTCUT_LABELS[id].blurb` is rendered verbatim in ⋯ Settings → Shortcuts
// (KeyboardShortcutsMenu.tsx), so it is user-facing text, not a comment. The `toggleComposer` blurb
// used to read "Improve-Sparkle pane only: move focus between its prompt box and terminal. (Builder
// agents have no terminal composer — the Sparkle box is the composer.)" That was accurate while the
// Improve Sparkle pane carried its own composer. That composer is gone — the pane now works like every
// other build agent, and you talk to an agent by clicking its row to mount Sparkle to it.
//
// ── WHY THIS IS A SUBSTRING CHECK AND NOT A CLEVER PREDICATE ────────────────────────────────────
//
// Two earlier cuts of this guard tried to detect a PROMISE, and roborev defeated both:
//
//   1. `!/move focus (between|to) [^.]*(prompt box|composer)/i` — required the literal "move focus",
//      so the third-person reword "Moves focus to the pane's prompt box…" walked past it (55580).
//      The shipped blurb passed only by the same accident, so its "no longer" did no work.
//   2. A verb-list + negation-position predicate — defeated by six more shapes (55606), all verified:
//      "Focuses the prompt box." (focus as a VERB was unreachable — the list required a verb THEN the
//      noun "focus"), "Puts you in the pane prompt box.", "Opens the pane prompt box so you can
//      type.", "Reveals the composer.", and two comma-joined denial-then-promise strings where a
//      negator attached to an EARLIER verb disarmed the whole clause. The last is not hypothetical:
//      the blurb's own first sentence is a contrastive denial, so joining it to a promise with a
//      comma instead of a period slipped through.
//
// Both cuts failed the same way — enumerating the ways English can express a promise, and each fix
// needing only a slightly different reword. The escape is to stop detecting promises and assert the
// INVARIANT instead: NO PANE HAS A PROMPT BOX, COMPOSE BOX OR COMPOSER, so the blurb has no business
// naming one — not even to deny it. The copy was reworded to say what the chord DOES ("Held in the
// terminal… To talk to an agent, click its row to mount Sparkle to it"), and the check became a
// substring scan.
//
// This is strictly STRONGER than either predicate, not a retreat: any wording that promises such a
// surface has to name it, so all eight defeating strings above are rejected — including the ones
// nobody thought to fixture. It is also immune to inflection, word order and negation, because it
// parses no grammar at all. The cost, taken deliberately: it also rejects a truthful DENIAL. Settings
// copy should say what a shortcut does, not narrate what it stopped doing, so that cost is a feature.
import { describe, expect, it } from "vitest";

import { SHORTCUT_LABELS, SHORTCUT_DEFAULTS, type ShortcutId } from "./keybindingsStore";

/**
 * Nouns for a per-pane text-entry surface. None of these exist in any pane — AgentPane's composer
 * went when the concierge became the one compose surface, and SparkleAgentPane's followed when
 * Improve Sparkle became a mounted build agent.
 */
const BOX_NOUN = /\b(?:prompt box|compose box|composer|text box|input box|typing area|text field)\b/i;

/** Every string that defeated an earlier cut of this guard. All of them name a box. */
const DEFEATED_EARLIER_CUTS = [
  // The original, and the reword that beat cut 1 (roborev 55580).
  "Improve-Sparkle pane only: move focus between its prompt box and terminal. (Builder agents have no terminal composer — the Sparkle box is the composer.)",
  "Moves focus to the pane's prompt box; or click a row to mount Sparkle to it.",
  // The six that beat cut 2 (roborev 55606).
  "Focuses the prompt box.",
  "Puts you in the pane prompt box.",
  "Opens the pane prompt box so you can type.",
  "Reveals the composer.",
  "Reserved in the terminal, so instead of reaching the running process it moves focus to the prompt box.",
  "Never reaches the running process, moves focus to the prompt box.",
  // Shapes neither cut was tested against, included because this check costs nothing to extend.
  "Moving focus into the composer, or mount Sparkle to a row.",
  "Bounces the caret back to the compose box. Mount Sparkle by clicking a row.",
  "Takes you to the prompt box. Or mount an agent.",
  "Jumps to the pane's text field.",
];

describe("the Shortcuts pane's toggleComposer copy", () => {
  it("names no per-pane text surface at all", () => {
    // The load-bearing case, and the whole invariant: no pane has one, so the copy cannot mention one.
    expect(SHORTCUT_LABELS.toggleComposer.blurb).not.toMatch(BOX_NOUN);
  });

  it("points the user at the gesture that actually reaches an agent", () => {
    // Removing a false promise without replacing it leaves a reader with no way in. The mount is the
    // way in now, so the copy has to say so. (Weak alone — several fixtures below mention mounting
    // too — which is why it sits beside the case above rather than standing in for it.)
    expect(SHORTCUT_LABELS.toggleComposer.blurb).toMatch(/mount/i);
  });

  it("no longer scopes itself to the Improve Sparkle pane", () => {
    // The chord is intercepted in EVERY terminal, so a pane-specific claim is wrong independently of
    // whether it names a box.
    expect(SHORTCUT_LABELS.toggleComposer.blurb).not.toMatch(/improve[- ]sparkle pane only/i);
  });

  it("every shortcut still has a title and a blurb", () => {
    // Cheap structural guard: the menu renders both for each id, so an empty one ships a blank row.
    for (const id of Object.keys(SHORTCUT_DEFAULTS) as ShortcutId[]) {
      expect(SHORTCUT_LABELS[id].title.trim().length).toBeGreaterThan(0);
      expect(SHORTCUT_LABELS[id].blurb.trim().length).toBeGreaterThan(0);
    }
  });
});

// The check itself, proven against every string that got past a previous version. Without this the
// file would be making the same unproven claim the last two cuts made.
describe("BOX_NOUN rejects every wording that defeated an earlier guard", () => {
  it.each(DEFEATED_EARLIER_CUTS)("rejects %j", (text) => {
    expect(text).toMatch(BOX_NOUN);
  });

  it("does not fire on copy that names no such surface", () => {
    // The false-positive side: the check must not flag wording that is simply about the terminal.
    expect("Held in the terminal so the chord never reaches the running process.").not.toMatch(
      BOX_NOUN,
    );
    expect("To talk to an agent, click its row to mount Sparkle to it.").not.toMatch(BOX_NOUN);
    // And it is scoped to a per-pane surface: the concierge's box is a different thing that still
    // exists, so plain talk about Sparkle must stay legal.
    expect("Mount Sparkle to a row and type to that agent.").not.toMatch(BOX_NOUN);
  });
});
