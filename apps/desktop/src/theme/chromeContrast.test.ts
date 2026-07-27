// NUMERIC FLOORS FOR THE SHELL'S CHROME, in both themes, computed from the actual hex.
//
// The regression this exists to prevent has already happened once, on the first cut of the
// black-and-gold repaint. That cut moved DARK onto the prototype's four near-black planes and left
// every chrome value that had been chosen against the OLD mid-navy exactly where it was:
//
//   • `forest`↔`deepForest` fell from 1.50:1 to 1.08:1. Dozens of components painted
//     `border: 1px solid ${C.forest}` on a `deepForest` panel and several painted
//     `background: C.forest` filled pills — modals lost their outline, pills stopped reading as
//     pills, and the credit badge landed at 1.20:1 on the column it sits in.
//   • the nudge badge's ink passed BRAND.sienna through unthemed under a comment asserting it was
//     legible in both themes; it clears neither end.
//   • opaque BRAND.gold — Send button, palette selection, chiclets — is a literal constant and
//     measured 1.19–1.64:1 on light mode's near-white surfaces.
//
// Every one of those shipped under a COMMENT claiming the separation held. So, exactly as
// xtermTheme.test.ts learned for the calm palette (roborev 46485-M / 46897): the floors are
// numbers in colors.ts, the comments state no ratios, and inequality assertions ("lighter than")
// are banned here — an inequality is precisely what let the 1.08:1 pair through.
import { describe, expect, it } from "vitest";
// The BRAND literals the tinted fills below composite. Imported, never re-typed: the gold hex had
// already been copied into three places (packages/ui/tokens.ts, THEME_HEX's goldInk/goldFill, and
// this file's `over()` calls), so retuning a brand token could leave this guard measuring a stale
// colour and still reporting green — a guard measuring the wrong input is the failure mode this
// whole file exists to prevent.
import { C as BRAND } from "@sparkle/ui";
import {
  CHROME_MIN_CONTRAST,
  CONTROL_MIN_CONTRAST,
  INK_MIN_CONTRAST,
  RAMP_MIN_SPLIT,
  THEME_HEX,
} from "./colors";

/** WCAG relative luminance of a #rrggbb string. */
function luminance(hex: string): number {
  const ch = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}

/** WCAG contrast ratio between two #rrggbb strings (1..21). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite a translucent color over an opaque one, the way `color-mix(… N%, transparent)` does
 *  over its backdrop — sRGB, which is the space the app's color-mix()es name. */
function over(fg: string, bg: string, pct: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const mix = (i: number) => Math.round(ch(fg, i) * pct + ch(bg, i) * (1 - pct));
  return "#" + [0, 1, 2].map((i) => mix(i).toString(16).padStart(2, "0")).join("");
}

const MODES = ["light", "dark"] as const;

/** The four depth planes. A chrome token has to hold its floor on ALL of them: a modal is a
 *  `deepForest` panel, the composer is `barSurface`, the concierge column is `conciergeSurface`,
 *  and an embedded terminal well is `forest` — the same border style draws on each. */
const PLANES = ["forest", "deepForest", "barSurface", "conciergeSurface"] as const;

/** The chrome slots, in ladder order: each one step further from the planes than the last. This
 *  array IS the ordering contract — see THE NEUTRAL LADDER in colors.ts. */
const CHROME = ["chatBubble", "pillFill", "chatBubbleActive", "hairline"] as const;

/** The chrome pairs a component actually COMPOSITES — paints one directly on top of the other.
 *  These clear the full CHROME_MIN_CONTRAST; every other pair in the ladder clears the weaker
 *  RAMP_MIN_SPLIT. Each entry names the site, so a future reader can check whether it still
 *  exists rather than inheriting the claim. */
const COMPOSITED_PAIRS = [
  // DragVisionHintPill: a `hairline` border on the card, a `pillFill` fill on the dismiss chip.
  ["hairline", "pillFill"],
  // AgentSidebar's "Improve Sparkle" row: `borderTop: 1px solid hairline` over the row's own
  // CHAT_USER_BUBBLE fill when it is active.
  ["hairline", "chatBubble"],
  // The row-state ramp: hovered vs the row you are IN.
  ["chatBubble", "chatBubbleActive"],
] as const;

describe("chrome separation — the shell's edges and fills", () => {
  // ── THE WHOLE LADDER, NOT A LIST OF REMEMBERED PAIRS ──────────────────────────────────────────
  // Three review rounds died on the same move: a token is nudged to clear the one floor someone
  // wrote down, and lands on top of a token nobody had thought to pair it with. `chatBubble` came
  // to rest on `hairline` and `chatBubbleActive` on `pillFill`, in BOTH themes, one round after a
  // fix whose entire purpose was to catch "two distinct values one hair apart" — and every
  // assertion in this file still passed, because none of them named those two pairs.
  //
  // So the ladder is swept exhaustively. Not "the pairs we know composite" — ALL of them.
  it("the neutral ladder keeps its ORDER: each chrome slot is one step further from the planes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      // "Further from the planes" is lighter in dark and darker in light, so compare against the
      // plane the chrome sits nearest: the lightest plane in dark, the darkest in light. Using the
      // theme's own direction rather than a hardcoded sign is what lets ONE ordering contract hold
      // in both themes.
      const anchor = mode === "dark" ? Math.max(...PLANES.map((p) => luminance(hex[p]))) : Math.min(...PLANES.map((p) => luminance(hex[p])));
      const distance = CHROME.map((t) => Math.abs(luminance(hex[t]) - anchor));
      expect(distance, `${mode}: ladder order ${CHROME.map((t) => `${t}=${hex[t]}`).join(" → ")}`).toEqual(
        [...distance].sort((a, b) => a - b),
      );
    }
  });

  it("every chrome slot clears the floor on EVERY plane, in both themes", () => {
    // `hairline` is the token that replaced `border: 1px solid ${C.forest}`; the old value was one
    // depth plane painted on another, which is why it collapsed when the planes converged. The
    // other three are fills that have to read as shapes. Same floor, same sweep — a modal is a
    // `deepForest` panel, the composer is `barSurface`, the concierge column is
    // `conciergeSurface`, an embedded terminal well is `forest`, and the same chrome draws on each.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const token of CHROME) {
        for (const plane of PLANES) {
          expect(
            contrast(hex[token], hex[plane]),
            `${mode}: ${token} (${hex[token]}) on ${plane} (${hex[plane]})`,
          ).toBeGreaterThanOrEqual(CHROME_MIN_CONTRAST);
        }
      }
    }
  });

  it("EVERY pair of chrome slots stays at least a ramp split apart — including the ones nobody paints together", () => {
    // The unglamorous one, and the only assertion here that would have caught round 3. A pair that
    // no component composites TODAY still cannot be allowed to converge: the ladder is what makes
    // the next edit safe, and "these two never meet" is a claim about the current component tree,
    // not about the palette.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (let i = 0; i < CHROME.length; i++) {
        for (let j = i + 1; j < CHROME.length; j++) {
          const [a, b] = [CHROME[i]!, CHROME[j]!];
          expect(
            contrast(hex[a], hex[b]),
            `${mode}: ${a} (${hex[a]}) vs ${b} (${hex[b]})`,
          ).toBeGreaterThanOrEqual(RAMP_MIN_SPLIT);
        }
      }
    }
  });

  it("the chrome pairs a component COMPOSITES clear the full chrome floor, not just the ramp split", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const [a, b] of COMPOSITED_PAIRS) {
        expect(
          contrast(hex[a], hex[b]),
          `${mode}: ${a} (${hex[a]}) composited with ${b} (${hex[b]})`,
        ).toBeGreaterThanOrEqual(CHROME_MIN_CONTRAST);
      }
    }
  });

  it("a `hairline` border around a `pillFill` chip still draws — measured, not merely unequal", () => {
    // They exist separately so a pill can carry both, and `DragVisionHintPill` is exactly that: a
    // `hairline` border on an element whose hover background is `pillFill`. So this is a live
    // combination, not a hypothetical.
    //
    // This case used to assert `hairline !== pillFill` — a string-identity check, which is the one
    // thing the header of this file bans. Two DISTINCT values one hair apart pass an inequality
    // and draw nothing; that is literally how the 1.08:1 pair got through. Measured, the tokens
    // were 1.14:1 (dark) and 1.18:1 (light) — the border on that chip did not exist, and this
    // test's own name said it did.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.hairline, hex.pillFill),
        `${mode}: hairline (${hex.hairline}) around a pillFill chip (${hex.pillFill})`,
      ).toBeGreaterThanOrEqual(CHROME_MIN_CONTRAST);
    }
  });

  // ── THE ROW-STATE RAMP ────────────────────────────────────────────────────────────────────────
  // `CHAT_USER_BUBBLE` / `ROW_ACTIVE_BUBBLE` are chrome FILLS — a hovered row, a selected row, the
  // user's own chat bubble, the terminal's selection band — and several sites use `chatBubble` as a
  // 1px BORDER (Terminal, Composer, PinnedPrompt, AttachmentTile, SparkleConsentBanner). They were
  // deliberately EXCLUDED from these floors, and that exclusion is what let them collapse WITH the
  // planes during the repaint (dark `#1d3a7a`→`#1b2033`, `#2c57b0`→`#2c3352`) down to ~1.04–1.16:1
  // across the whole ramp — while colors.ts went on documenting "three states read at a glance".
  //
  // Held to the same CHROME_MIN_CONTRAST as `hairline`/`pillFill` because they do the same job: a
  // filled row state has to read as a shape. No new, softer constant — the pre-repaint DARK pair
  // delivered 1.598:1 between the two bubbles, so this floor restores what the contract was
  // written against rather than lowering the bar to fit what broke it.
  //
  // Sweeping every plane is not over-reach: in dark, clearing `conciergeSurface` (the lightest
  // plane) implies the rest; in light, clearing `deepForest` (the darkest) does. The binding
  // constraint in each theme is one of the two planes these fills are actually painted on.
  it("`chatBubble` and `chatBubbleActive` clear the floor on EVERY plane, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const token of ["chatBubble", "chatBubbleActive"] as const) {
        for (const plane of PLANES) {
          expect(
            contrast(hex[token], hex[plane]),
            `${mode}: ${token} (${hex[token]}) on ${plane} (${hex[plane]})`,
          ).toBeGreaterThanOrEqual(CHROME_MIN_CONTRAST);
        }
      }
    }
  });

  it("the two row-state fills stay a step apart — the 'three states' contract, as a number", () => {
    // colors.ts documents ROW_ACTIVE_BUBBLE as "one notch more contrast than CHAT_USER_BUBBLE so
    // three states read at a glance": idle (the bare plane), hovered (chatBubble), selected
    // (chatBubbleActive). The first step is the assertion above; this is the second. Without it,
    // the two can converge and every state still clears its plane individually.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.chatBubble, hex.chatBubbleActive),
        `${mode}: chatBubble (${hex.chatBubble}) vs chatBubbleActive (${hex.chatBubbleActive})`,
      ).toBeGreaterThanOrEqual(CHROME_MIN_CONTRAST);
    }
  });

  // ── THE CAP, AND THE PREMISE IT USED TO REST ON ───────────────────────────────────────────────
  // This cap was justified as "these fills carry `cream` text at EVERY site that uses them". That
  // was not true when it was written. `AgentSidebar`'s hover card set `background: CHAT_USER_BUBBLE`
  // for any row that is not active and then filled it with the column's PLANE inks — `muted`
  // DetailLine labels, a `successInk` "✓ Landed", an `accentInk` path link — so the cap was chosen
  // against a backdrop/ink pairing that was not the real one, and the card's own text sat under its
  // floor at both ends of the theme.
  //
  // No value of `chatBubble` could have fixed that, which is the useful part: `muted` cannot clear
  // the ink floor on ANY chrome fill in EITHER theme (the assertion below measures exactly that),
  // because every slot that clears the chrome floor against the planes is already past the backdrop
  // `muted` can be read on. So the card moved to a PLANE (`barSurface`) instead — see
  // AgentSidebar's `cardBg`.
  //
  // THE FIX THEN RECORDED "what is left on this token is what its name says: chat bubbles and row
  // fills, carrying `cream`", AND THAT WAS ALSO FALSE (roborev 53613). A FOURTH consumer was still
  // there: `AgentSidebar`'s pinned "Improve Sparkle" row painted `background: active ?
  // CHAT_USER_BUBBLE : "transparent"` under a comment claiming it matched the agent rows' selected
  // treatment — which it did not, since a selected agent row takes `C.forest`. Everything that row
  // carries is a plane ink: a `statusInk(...)` label (3.20/3.71 dark/light on the bubble), a
  // `muted` consent pill (3.20/2.38), and a StatusDot measuring 2.64/1.70 red and 4.56/1.01 green —
  // the dot the row is read by, effectively invisible in light. That row now takes `C.forest` like
  // every other selected row, and the claim is finally true: the sites below are all this token has.
  //
  // The lesson worth keeping is that the claim was re-asserted from a comment TWICE without anyone
  // grepping the token. The `it` below therefore names its real consumers, and the sweep in
  // "the AgentSidebar hover CARD" further down measures the card's inks on the surface it actually
  // has rather than on the one a table remembered.
  const CREAM_CARRYING_FILLS = ["chatBubble", "chatBubbleActive", "pillFill"] as const;

  it("`cream` stays readable ON every chrome FILL — the cap that stops the ladder overshooting", () => {
    // chatBubble: DefineStageModal's user line, SupportModal's user turn, ConciergeThread's own
    // bubble, PinnedPrompt's hovered row, NudgeCard's secondary action.
    // chatBubbleActive: SettingsDialog's selected rail item, DefineStageModal's primary button,
    // StageColumnHeader's CTA.
    // pillFill: the credit badge, BalanceBadge, ModelPill's and AgentPane's selected rows,
    // SelectionPopup's hover.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const token of CREAM_CARRYING_FILLS) {
        expect(
          contrast(hex.cream, hex[token]),
          `${mode}: cream (${hex.cream}) on ${token} (${hex[token]})`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  it("`muted` is a PLANE ink: it clears AA on every plane and on NO chrome fill — the stated exception", () => {
    // Pinned as a fact about the ladder, not left as a comment. The first half is the contract
    // `muted` actually has; the second half is why re-pointing a surface (not re-deriving a token)
    // is the only fix when a `muted` label turns up on a fill, and it fails loudly if a future
    // palette edit ever makes the exception unnecessary — at which point delete it and lift the
    // restriction rather than carrying a false comment.
    //
    // The one plane it does NOT clear is light `deepForest`, a pre-existing light-mode gap that
    // predates this ladder and is not its to close — so the plane half is asserted where `muted` is
    // read: the dark shell, and light's two lighter chrome planes.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      const planes = mode === "dark" ? PLANES : (["forest", "barSurface", "conciergeSurface"] as const);
      for (const plane of planes) {
        expect(
          contrast(hex.muted, hex[plane]),
          `${mode}: muted (${hex.muted}) on ${plane} (${hex[plane]}) — muted is a PLANE ink`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
      for (const token of CREAM_CARRYING_FILLS) {
        expect(
          contrast(hex.muted, hex[token]),
          `${mode}: muted (${hex.muted}) on ${token} (${hex[token]}) — if this now PASSES, the stated exception in colors.ts is stale`,
        ).toBeLessThan(INK_MIN_CONTRAST);
      }
    }
  });

  // ── THE AGENTSIDEBAR HOVER CARD, MEASURED ON THE SURFACE IT ACTUALLY HAS ──────────────────────
  // The card's surface moved `chatBubble` → `barSurface` precisely so its three inks would clear,
  // and then only ONE of the three was pinned: `muted`, and only incidentally, as a member of the
  // `muted` plane sweep above. `successInk` (the "✓ Landed" mark) and `accentInk` (the path link)
  // were the numbers the move was JUSTIFIED by and neither was asserted anywhere — a component test
  // pinned the token string `var(--c-bar-surface)` instead, which cannot catch a palette edit that
  // keeps the token and moves its value (roborev 53614).
  //
  // BOTH card states, because `cardBg` is `isActive ? C.forest : C.barSurface` — a sweep over only
  // the inactive one would leave the active card's inks exactly as unpinned as these were.
  const CARD_SURFACES = ["barSurface", "forest"] as const;
  const CARD_INKS = ["muted", "successInk", "accentInk"] as const;

  it("the hover card's OWN inks clear AA on the card's own surface, in both card states", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const surface of CARD_SURFACES) {
        for (const ink of CARD_INKS) {
          expect(
            contrast(hex[ink], hex[surface]),
            `${mode}: ${ink} (${hex[ink]}) on the hover card's ${surface} (${hex[surface]})`,
          ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
        }
      }
    }
  });

  // The card's "N ahead — click to merge" pill. Its ink is `successInk` and it used to paint a
  // `${C.success}22` wash behind it; the ladder's table measured the ink on the BARE plane (light
  // 4.552 on `barSurface`) and so never saw that the wash took it to 4.127 — under the floor — while
  // buying 1.103:1 of visible fill. The wash is gone; this pins that it cannot come back without the
  // ink being re-measured ON it. Asserted as the composited stack, not as "the background is
  // transparent", so any future tint has to clear the floor rather than merely be a different value.
  it("the ahead pill's ink clears AA on whatever it is composited over", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const surface of CARD_SURFACES) {
        expect(
          contrast(hex.successInk, hex[surface]),
          `${mode}: successInk on the untinted ahead pill over ${surface}`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
    // And the exact stack that FAILED is recorded, so the wash cannot be restored as "harmless".
    // Light only, and stated rather than swept: in dark the same wash measures 6.192 and passes
    // comfortably, which is precisely how a bare-plane measurement hid the light-mode failure.
    expect(
      contrast(THEME_HEX.light.successInk, over(BRAND.success, THEME_HEX.light.barSurface, 0x22 / 255)),
      "light: successInk over a success22 wash on the barSurface card — this is why the wash went",
    ).toBeLessThan(INK_MIN_CONTRAST);
  });

  // ── FILLED CHIPS INSIDE THAT CARD ─────────────────────────────────────────────────────────────
  // Three chips in the card's top strip filled with `C.deepForest` — a PLANE used as a chip fill on
  // another plane, which is 1.079/1.248 against the card: a filled chip with no visible fill
  // (roborev 53616). ModelPill and the close button's hover pill moved to `pillFill`, the token
  // whose documented role is exactly this. Swept over both card states for the same reason as above.
  it("a filled chip inside the hover card reads as a fill against the card, in both card states", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const surface of CARD_SURFACES) {
        expect(
          contrast(hex.pillFill, hex[surface]),
          `${mode}: a pillFill chip on the ${surface} card`,
        ).toBeGreaterThanOrEqual(CHROME_MIN_CONTRAST);
        // The value they came FROM, recorded as failing so the move cannot be quietly reverted.
        expect(
          contrast(hex.deepForest, hex[surface]),
          `${mode}: a deepForest chip on the ${surface} card — a plane on a plane`,
        ).toBeLessThan(CHROME_MIN_CONTRAST);
      }
    }
  });

  // The epic pill keeps its `deepForest` fill (its `C.teal` ink measures 1.828/1.610 on `pillFill` —
  // the fill that would make it a proper chip is the one that destroys its ink, a STATED exception),
  // so its boundary has to come from its border instead. It was `${C.teal}55`, which measured
  // 1.376:1 against the dark card — no boundary from any direction. `hairline` is the token for a
  // rule that has to be seen, and it has to clear the chip's own fill as well as the card behind it.
  it("the epic pill's hairline border is visible against BOTH its own fill and the card", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.hairline, hex.deepForest),
        `${mode}: the epic pill's border against its own deepForest fill`,
      ).toBeGreaterThanOrEqual(CHROME_MIN_CONTRAST);
      for (const surface of CARD_SURFACES) {
        expect(
          contrast(hex.hairline, hex[surface]),
          `${mode}: the epic pill's border against the ${surface} card`,
        ).toBeGreaterThanOrEqual(CHROME_MIN_CONTRAST);
      }
      // What it replaced, pinned as insufficient in dark so the tint cannot come back.
      expect(
        contrast(over(BRAND.teal, hex.deepForest, 0x55 / 255), hex.barSurface),
        `${mode}: the old teal55 edge against the barSurface card`,
      ).toBeLessThan(2);
    }
  });

  // ── THE PINNED "IMPROVE SPARKLE" ROW'S SELECTED STATE ─────────────────────────────────────────
  // Two rounds moved this row's active fill and neither left it visible. It went CHAT_USER_BUBBLE →
  // `C.forest` (roborev 53613) because everything the row carries is a PLANE ink and a chrome fill
  // cannot hold one — that part stands, and the numbers are in the row's own comment. What the move
  // did not account for is that `forest` on the sidebar's `deepForest` column is the pair the
  // repaint deliberately collapses. An AGENT row survives that: its selected state is the square
  // right edge, the concave fillets opening onto the terminal, and the open card's outline. This row
  // has none of that geometry, so it was left with an invisible fill and nothing else (roborev
  // 53662).
  //
  // The fix cannot be a different FILL — the ladder's stated exception says every fill far enough
  // from the planes to read is already past what `muted` and this row's other plane inks can be read
  // on. So the state is a SHAPE beside the inks rather than a fill under them: the `goldFill` rail
  // `CommandPalette`'s selected row already uses. Held to CONTROL_MIN_CONTRAST, not the softer
  // divider floor, for the same reason the Send button is: this contrast IS the state.
  //
  // The wash `CommandPalette` pairs with its rail is NOT carried over, and is stated here rather
  // than asserted: 8% gold over the sidebar column measures 1.152 (dark) / 1.016 (light) against the
  // bare column — nothing in light, where this row is exactly as invisible as before — while tinting
  // the backdrop every one of the row's plane inks is measured on. It is left out as an assertion
  // because an 8% wash of anything is under the chrome floor by construction, and a test that cannot
  // fail is what the header of this file bans.
  it("the Improve Sparkle row's gold rail reads against both its own fill and the column", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      // The row's own active fill, and the column the rail's outer edge abuts.
      for (const backdrop of ["forest", "deepForest"] as const) {
        expect(
          contrast(hex.goldFill, hex[backdrop]),
          `${mode}: the selected row's goldFill rail (${hex.goldFill}) on ${backdrop} (${hex[backdrop]})`,
        ).toBeGreaterThanOrEqual(CONTROL_MIN_CONTRAST);
      }
    }
  });

  it("the row's FILL step is below the chrome floor — which is why the rail has to exist", () => {
    // Recorded as a failing measurement, not as a comment, so a future round cannot delete the rail
    // on the theory that "the active fill already says it". It does not, at either end: this is the
    // plane pair the repaint collapses on purpose, and nothing here proposes raising it.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.forest, hex.deepForest),
        `${mode}: the active row's forest fill (${hex.forest}) against the deepForest column (${hex.deepForest})`,
      ).toBeLessThan(CHROME_MIN_CONTRAST);
    }
  });

  // The pair the repaint collapses. It is NOT raised back — four near-black planes are what the
  // prototype specifies, `forest` is also the terminal background every calm ink is measured
  // against, and a recession ramp is supposed to recede. What is pinned instead is that DARK
  // keeps the prototype's ordering, so a future edit can't silently invert
  // "Sparkle lightest → builder → terminal darkest" (PRD/sparkle/concierge-mode.md §3) while the
  // surfaces comment goes on claiming it.
  //
  // Only DARK. Light's four planes are not a mirror of it and never were: `forest` there is the
  // WHITE content plane (the lightest of everything, not the darkest), and among the chrome
  // planes light orders builder → concierge → bars where dark orders builder → bars → concierge.
  // Asserting a symmetry that doesn't hold would just be another comment that isn't true.
  it("DARK keeps the prototype's depth ramp: term → builder → bars → concierge", () => {
    const ramp = PLANES.map((p) => luminance(THEME_HEX.dark[p]));
    expect(ramp).toEqual([...ramp].sort((a, b) => a - b));
    // Strictly increasing — equal neighbours would satisfy a sort but would BE the flattening.
    expect(new Set(ramp).size).toBe(PLANES.length);
  });

  it("the concierge column stays a distinct plane from the builder column, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(luminance(hex.conciergeSurface), `${mode}: concierge vs builder`).toBeGreaterThan(
        luminance(hex.deepForest),
      );
    }
  });
});

describe("the concierge column's themed INKS clear AA where they are read", () => {
  // Scoped to `conciergeSurface` ON PURPOSE. These are the concierge column's inks — the scope
  // line, the vitals, a nudge's badge and project chip — and that column is the surface they are
  // read on. Sweeping them across all four planes instead would assert a contract they were never
  // given and would fold in a PRE-EXISTING light-mode gap that is not this change's to close
  // (light `muted`/`conciergeMuted` #5b6b8c measures 3.89:1 on the light SIDEBAR, #d9dce1) — a
  // test that fails for something you are not fixing gets weakened, and then it guards nothing.
  const INKS = ["conciergeMuted", "dangerInk", "goldInk", "goldHotInk"] as const;

  it("every concierge ink on the concierge column, both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const ink of INKS) {
        expect(
          contrast(hex[ink], hex.conciergeSurface),
          `${mode}: ${ink} (${hex[ink]}) on conciergeSurface (${hex.conciergeSurface})`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  // ── MEASURE THE STACK THE LABEL IS ACTUALLY READ ON ───────────────────────────────────────────
  // A nudge's inks are not read on the bare column, and the first cut of these assertions did not
  // composite far enough. NudgeCard paints, from the bottom up:
  //
  //   conciergeSurface
  //     └─ the CARD: linear-gradient(color-mix(sienna 9%) → color-mix(sienna 3%))
  //          ├─ the BADGE:   its own color-mix(sienna 16%) fill  → label is `dangerInk`
  //          ├─ the CHIP:    NO fill of its own (border only)    → label is `goldInk`
  //          └─ the PRIMARY: its own color-mix(gold 16%) fill    → label is `goldHotInk`
  //
  // Every tint LIFTS the backdrop in dark and DARKENS it in light, so which gradient stop is the
  // worst case flips between themes — both stops are measured rather than guessing at one.
  const gradient = (mode: (typeof MODES)[number], stop: number) =>
    over(BRAND.sienna, THEME_HEX[mode].conciergeSurface, stop);
  const GRADIENT_STOPS = [0.09, 0.03] as const; // the card's two `linear-gradient(180deg, …)` ends

  // The badge is the pair that made BRAND.sienna's "legible in both themes" claim false, and it
  // stayed wrong one layer deeper: the guard composited ONLY the card's gradient while the badge
  // paints its own 16% sienna on top of that, and the label sits on THAT. Measured properly,
  // `dangerInk` did not clear AA at either end — which is precisely how a "the guard covers it"
  // claim keeps a sub-floor value shipping.
  it("`dangerInk` clears AA on the badge's OWN fill — the card's gradient AND the badge's tint", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const stop of GRADIENT_STOPS) {
        const badgeFill = over(BRAND.sienna, gradient(mode, stop), 0.16);
        expect(
          contrast(hex.dangerInk, badgeFill),
          `${mode}: dangerInk (${hex.dangerInk}) on the badge fill (${badgeFill}) at gradient ${stop}`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  // The project chip. Its comment named this surface while the assertion measured a 16% gold tint
  // the chip never paints — the chip is a bordered label with NO background, so what it is read on
  // is the card gradient itself.
  it("`goldInk` clears AA on the project chip's real backdrop — the card gradient, no fill", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const stop of GRADIENT_STOPS) {
        expect(
          contrast(hex.goldInk, gradient(mode, stop)),
          `${mode}: goldInk (${hex.goldInk}) on the card gradient (${gradient(mode, stop)}) at ${stop}`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  // THE FOURTH INK, which the pass that introduced the three above did not measure — and it was the
  // one that failed. `NudgeCard.tsx` paints `color: C.conciergeMuted` on the card's META ROW (the
  // agent name beside the band badge) and on its ghost action, both directly on the card's gradient
  // with no fill of their own. Measuring three of a card's four inks on their real stack and
  // skipping the fourth leaves the reader with a file that looks exhaustive and is not; light mode
  // was under the floor at both gradient stops until `conciergeMuted` moved for it.
  it("`conciergeMuted` clears AA on the card gradient it is read on — the meta row and the ghost action", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const stop of GRADIENT_STOPS) {
        expect(
          contrast(hex.conciergeMuted, gradient(mode, stop)),
          `${mode}: conciergeMuted (${hex.conciergeMuted}) on the card gradient (${gradient(mode, stop)}) at ${stop}`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  // The 16% gold tint the old `goldInk` case was measuring DOES exist — it is the primary action
  // button. But that button's label is `goldHotInk`, not `goldInk`, and the tint composites over
  // the card gradient rather than the bare column. So the surface is kept and pointed at the ink
  // that is actually painted on it.
  it("`goldHotInk` clears AA on the primary action button's gold tint", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const stop of GRADIENT_STOPS) {
        const buttonFill = over(BRAND.gold, gradient(mode, stop), 0.16);
        expect(
          contrast(hex.goldHotInk, buttonFill),
          `${mode}: goldHotInk (${hex.goldHotInk}) on the primary button (${buttonFill}) at ${stop}`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  // ── THE SURFACE THE NUDGE-CARD FIX ABANDONED ──────────────────────────────────────────────────
  // `goldInk` on a translucent gold tint used to be measured here. Repointing that case at
  // NudgeCard's project chip was right for NudgeCard — the chip paints no fill — but the ABANDONED
  // pairing is live one component over: `CommandPalette`'s `kindBadge` puts `goldInk` on a 14% gold
  // wash, and `accentInk` on a 14% accent wash, over the palette's own `deepForest` panel. Losing
  // the only guard on a pairing because a DIFFERENT component stopped using it is how a surface
  // goes unmeasured; the case follows the tint to wherever the tint actually is.
  it("`kindBadge`'s inks clear AA on their tints over the palette panel — selected row included", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      // The selected result row washes 8% gold over the panel FIRST, so the badge tint composites
      // over that, not over the bare panel. Both rows are measured — the badge renders on either.
      const rows = [hex.deepForest, over(BRAND.gold, hex.deepForest, 0.08)];
      for (const row of rows) {
        for (const [ink, tint] of [
          ["goldInk", BRAND.gold],
          ["accentInk", BRAND.accent],
        ] as const) {
          const fill = over(tint, row, 0.14);
          expect(
            contrast(hex[ink], fill),
            `${mode}: ${ink} (${hex[ink]}) on the ${tint} 14% badge tint (${fill}) over row ${row}`,
          ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
        }
      }
    }
  });
});

describe("opaque gold is a themed PAIR — fill and the ink that sits on it", () => {
  it("`goldFill` clears the non-text control floor on every plane, in both themes", () => {
    // The Send button has no border; this contrast IS its edge. Held to WCAG 1.4.11's 3:1 rather
    // than the softer divider floor for that reason.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const plane of PLANES) {
        expect(
          contrast(hex.goldFill, hex[plane]),
          `${mode}: goldFill (${hex.goldFill}) on ${plane} (${hex[plane]})`,
        ).toBeGreaterThanOrEqual(CONTROL_MIN_CONTRAST);
      }
    }
  });

  it("`onGoldFill` clears AA on `goldFill` — pick one and you have picked both", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.onGoldFill, hex.goldFill),
        `${mode}: onGoldFill (${hex.onGoldFill}) on goldFill (${hex.goldFill})`,
      ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
    }
  });

  it("dark keeps the prototype's own gold — the repaint's whole point", () => {
    // PRD/sparkle/concierge-mode/prototype.html `:root { --gold: #f5c26b; --ink: #090b14 }`.
    // Theming the token must not have quietly redesigned the approved dark look.
    expect(THEME_HEX.dark.goldFill).toBe("#f5c26b");
    expect(THEME_HEX.dark.onGoldFill).toBe("#090b14");
    expect(THEME_HEX.dark.goldInk).toBe("#f5c26b");
    expect(THEME_HEX.dark.goldHotInk).toBe("#ffe9b8");
  });
});
