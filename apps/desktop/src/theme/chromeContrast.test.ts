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
import { AGENT_STATUS } from "@sparkle/ui";
// The BRAND literals the tinted fills below composite. Imported, never re-typed: the gold hex had
// already been copied into three places (packages/ui/tokens.ts, THEME_HEX's goldInk/goldFill, and
// this file's `over()` calls), so retuning a brand token could leave this guard measuring a stale
// colour and still reporting green — a guard measuring the wrong input is the failure mode this
// whole file exists to prevent.
import { C as BRAND } from "@sparkle/ui";
import {
  BADGE_EDGE_PCT,
  C,
  CHROME_MIN_CONTRAST,
  CONTROL_MIN_CONTRAST,
  DANGER,
  INK_MIN_CONTRAST,
  PLANE_MIN_SPLIT,
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
    // THE STACK THAT FAILED NOW CLEARS, and the record is updated rather than deleted. The wash was
    // removed because `successInk` could not be read over it in light mode; the Blueprint repaint
    // darkened light's green (the terminal became a real plane, so every light ink was re-derived
    // against it) and the same stack now measures comfortably above the floor. Kept as a POSITIVE
    // assertion so the number stays pinned: if a future palette lightens that green back, this goes
    // red before anyone reintroduces the wash on the strength of a stale comment.
    expect(
      contrast(THEME_HEX.light.successInk, over(BRAND.success, THEME_HEX.light.barSurface, 0x22 / 255)),
      "light: successInk over a success22 wash on the barSurface card",
    ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
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
  //
  // The rail's own floor is NOT re-asserted here, for that same reason. It is already held by
  // "`goldFill` clears the non-text control floor on every plane, in both themes" below, which
  // sweeps `PLANES` — `forest` and `deepForest` among them — over `MODES` at `CONTROL_MIN_CONTRAST`.
  // A row-scoped copy over those two planes is a strict subset of that sweep: no palette edit can
  // redden it without reddening the sweep first, so it measured nothing and merely looked like the
  // rail's guard (roborev 53685). What IS asserted is the half the sweep does not cover — that the
  // fill step this rail replaces falls BELOW the floor, which is the reason the rail exists at all.
  //
  // THE PAIR IS BOUNDED FROM BOTH SIDES, AND THIS IS ITS ONE HOME. The floor arrived later than the
  // ceiling and briefly lived in a second test of its own, which re-asserted this exact ceiling over
  // the same pair and the same MODES — a byte-for-byte duplicate, i.e. the strict-subset defect the
  // note directly above bans, introduced by the commit that was removing a phantom guard (roborev
  // 54234). Both bounds belong together anyway: they are one decision about one seam.
  //
  // The floor exists because AgentSidebar removed this column's hairline. With no drawn rule, the
  // step itself carries the app's most prominent structural edge, and nothing was holding it up —
  // both assertions naming the pair were ceilings, so a future nudge could have flattened it toward
  // 1.0 with the suite green. That is the state the hairline had been added to escape.
  //
  // ── LIGHT SITS AT 1.2012, AND THAT IS SATURATION, NOT SLOPPINESS (roborev 54234) ──────────────
  // Light clears this floor by 0.0012 — one 8-bit nudge from red — which reads like a value nobody
  // finished tuning. It is not. Light's ramp is fully constrained and the headroom cannot be
  // created, only MOVED. The budget is pinned at both ends: `conciergeSurface` is white, every
  // chrome slot must clear CHROME_MIN_CONTRAST against the darkest plane, and `cream` must still
  // clear AA on `chatBubbleActive`. Widening this seam darkens `forest`, which drags the whole
  // chrome ladder down into the `cream` cap.
  //
  // Measured, by moving the seam to 1.29: the `chatBubble` window collapses from ~0.034 luminance
  // (~9 representable values) to ~0.0045 (~1). So the choice is a seam with one step of margin, or
  // a chrome ladder with one step of margin — and the ladder is the worse place to spend it,
  // because four slots share that budget and three of them carry ink.
  //
  // The other option on the table was keeping `hairline` on this seam in LIGHT only. Rejected: the
  // active row bleeds in both themes, so a rule in one would make the app's most visible behaviour
  // theme-dependent — a visible inconsistency in exactly the feature the seam exists for.
  //
  // What makes 1.2012 safe is not margin, it is the guard: this now fails in BOTH directions, so
  // erosion is caught by CI rather than by a reviewer. If the ramp is ever re-derived, spend any
  // new room here first. PRD/sparkle/ui-directions/derive.mjs holds the arithmetic.
  it("the active row's FILL step is a visible plane step AND below the chrome floor", () => {
    // Recorded as measurements, not as a comment, so a future round cannot delete the rail on the
    // theory that "the active fill already says it", nor flatten the seam the rail replaced.
    expect(PLANE_MIN_SPLIT, "the band is empty — the two bounds cross").toBeLessThan(CHROME_MIN_CONTRAST);
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      const step = contrast(hex.forest, hex.deepForest);
      // FLOOR — the seam is undrawn, so it has no fallback if the fill goes flat.
      expect(
        step,
        `${mode}: forest (${hex.forest}) against deepForest (${hex.deepForest}) is too flat to carry an undrawn seam`,
      ).toBeGreaterThanOrEqual(PLANE_MIN_SPLIT);
      // CEILING — and it must still not read as a chrome FILL, which is why the rail exists.
      expect(
        step,
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

  // ── LIGHT'S THREE COLUMNS ─────────────────────────────────────────────────────────────────────
  // The founder's report was "a mishmash of shades … gray-on-gray", and light's planes were the
  // literal cause: terminal → concierge measured 1.162:1 and concierge → builder 1.184:1, i.e. BOTH
  // under RAMP_MIN_SPLIT — the floor this file already applies to two chrome tokens that no
  // component ever paints on top of each other. Three panes side by side had less separation than
  // the palette demands of two values that never meet.
  //
  // DARK IS NOT SWEPT, and the asymmetry is the point rather than an omission: dark's four planes
  // are the prototype's near-blacks and the section at the top of colors.ts spends a paragraph on
  // why that ramp is SUPPOSED to collapse. Light has a white content plane and no such excuse.
  //
  // The ramp's LAST rung is additionally bounded from above, by "the active row's FILL step is a
  // visible plane step AND below the chrome floor" earlier in this file, which brackets
  // `forest`↔`deepForest` between PLANE_MIN_SPLIT and CHROME_MIN_CONTRAST in both themes.
  //
  // WHAT USED TO BE ARGUED HERE — that contrast multiplies along the ramp, so the two steps share a
  // hard ceiling of 1.5 and neither may exceed √1.5 — IS RETRACTED. It was sound for a three-plane
  // ramp and became false the moment `barSurface` joined as a rung: four planes at the floor span
  // well past 1.5 by construction, and light's ramp does. The 1.5 bound is on ONE adjacent pair,
  // not on the ramp end to end, and it is not what fixes PLANE_MIN_SPLIT. See the ramp section at
  // the top of colors.ts.
  //
  // ── THIS GUARD MEASURED NON-ADJACENT PAIRS, AND THAT IS WHY IT WAS GREEN ───────────────────────
  // It swept `["forest", "conciergeSurface", "deepForest"]` — the ordering from BEFORE the ramp was
  // inverted. Under the new contract those first two are the two ENDS of the ramp, so the guard was
  // measuring the end-to-end distance (1.590) and calling it one step, while the ramp's real
  // adjacent steps went unmeasured: `barSurface`↔`conciergeSurface` at 1.098 and
  // `deepForest`↔`barSurface` at 1.109, BOTH under this very floor. A guard that reads the wrong
  // pairs reports clean for the wrong reason, which is worse than no guard — and `barSurface` is
  // where the gray-on-gray collapse had quietly moved to, since it is the plane every inactive
  // agent card and every bar is painted in.
  //
  // It now sweeps the ramp IN ORDER, every adjacent pair, so adding or reordering a plane cannot
  // slip past it. `barSurface` is included deliberately: the commit's thesis is that the shell
  // darkens THROUGH the bars, which makes the bar a rung rather than an overlay.
  const LIGHT_RAMP = ["conciergeSurface", "barSurface", "deepForest", "forest"] as const;
  it("LIGHT's planes are far enough apart to read as separate planes — EVERY adjacent pair", () => {
    const hex = THEME_HEX.light;
    for (let i = 0; i < LIGHT_RAMP.length - 1; i++) {
      const [a, b] = [LIGHT_RAMP[i]!, LIGHT_RAMP[i + 1]!];
      expect(
        contrast(hex[a], hex[b]),
        `light: ${a} (${hex[a]}) beside ${b} (${hex[b]})`,
      ).toBeGreaterThanOrEqual(PLANE_MIN_SPLIT);
    }
    // …and the sweep is only honest if the order it sweeps IS the luminance order. Pin that too,
    // or a future value swap silently turns "adjacent" back into "some pair".
    const lums = LIGHT_RAMP.map((k) => luminance(hex[k]));
    expect(lums, `light ramp is not monotonically darkening: ${LIGHT_RAMP.join(" → ")}`)
      .toEqual([...lums].sort((x, y) => y - x));
    // The FLOOR is boxed from below (roborev 53986). A plane split may not be laxer than the bar
    // applied to two chrome tokens that never touch — at 1.18 this guard passed the very spacing it
    // was written to reject, which is a guard that records a decision without enforcing it.
    expect(PLANE_MIN_SPLIT).toBeGreaterThanOrEqual(RAMP_MIN_SPLIT);
  });

  // The `forest`↔`deepForest` seam is bounded from both sides, and its one home is the
  // "active row's FILL step" test further up this file — not here. LIGHT_RAMP's last step overlaps
  // that floor for light by construction (the pair is the ramp's final rung); the band test is what
  // covers DARK and what states the ceiling, so read it there before touching either.

  //
  // ORDERING WAS ALL THIS PAIR HAD, WHICH IS HOW ITS NUMBER ROTTED IN PROSE (roborev 54242). The
  // concierge↔builder seam is the shell's other vertical boundary, and it was described in comments
  // in three files with a hand-written ratio and NOTHING computing it — so when `deepForest` was
  // re-derived, the quoted figure silently became wrong and stayed wrong through two rounds.
  // Ordering alone could not catch it: `conciergeSurface` stayed lighter the whole time.
  //
  // PHYSICALLY ADJACENT, NOT ADJACENT IN THE RAMP — and the first cut of this guard conflated the
  // two (roborev 54250). These columns touch ON SCREEN, but `barSurface` sits between them in
  // LUMINANCE, so calling this "the same floor as every other adjacent rung" described it as
  // exactly the non-adjacent measurement this file condemns forty lines up.
  //
  // The floor is therefore DARK-ONLY. Contrast is multiplicative along a monotone ramp, so light's
  // two intervening steps already force this pair to ≥ 1.2 × 1.2 = 1.44 — it cannot fail without
  // LIGHT_RAMP failing first, which makes a light assertion here a strict subset, the thing
  // roborev 53685/54234 banned. Dark's ramp is not swept, so dark is the only place this seam has
  // no cover at all, and it is the tightest unbudgeted constraint on dark's planes: re-deriving
  // them toward the prototype's near-blacks will hit this before anything else.
  it("the concierge column stays a distinct plane from the builder column, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(luminance(hex.conciergeSurface), `${mode}: concierge vs builder`).toBeGreaterThan(
        luminance(hex.deepForest),
      );
    }
    const hex = THEME_HEX.dark;
    expect(
      contrast(hex.conciergeSurface, hex.deepForest),
      `dark: conciergeSurface (${hex.conciergeSurface}) against deepForest (${hex.deepForest}) — the seam ConciergeColumn draws its rule on`,
    ).toBeGreaterThanOrEqual(PLANE_MIN_SPLIT);
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

  // ── THE BADGE GUARD MEASURED A PAIRING THE COMPONENT HAD STOPPED USING ────────────────────────
  // This asserted `goldInk` and `accentInk` on 14% BRAND tints. `kindBadge` uses neither: `goldInk`
  // left when gold was retired, and the 14% wash left when the kind treatment changed. So the only
  // guard on this component measured something that does not render, while every composite that
  // DOES ship went unmeasured — which is exactly how a light-mode regression shipped green, twice
  // (roborev 54253). The badge's edge had fallen to 1.079 against the panel in light: no visible
  // boundary at all, with the suite passing.
  //
  // It measures what ships now: the themed edge at both weights, on both surfaces the badge renders
  // on, in both themes. And the LABEL is measured on the ground it actually sits on — the badge
  // has no fill, precisely because a tint of `accentInk` under `accentInk` text is self-defeating
  // (the label drops under AA at a 14% fill and keeps falling), which is the constraint that chose
  // edge weight as the signal in the first place.
  //
  // THE WEIGHTS ARE IMPORTED FROM THE COMPONENT, not re-declared here (roborev 54263). A local copy
  // meant this guard could not observe the value an edit would change: dropping the weak edge back
  // to 32% — which is what produced the invisible light-mode edge — would have left the test still
  // measuring its own 45% and still passing. A guard that cannot see the thing it guards is the
  // failure this whole block is a record of.
  it("`kindBadge`'s edges clear the chrome floor at BOTH weights, on both rows and both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      // The selected result row washes 8% over the panel FIRST, so the badge edge composites over
      // that, not over the bare panel. Both are measured — the badge renders on either.
      const rows = [hex.deepForest, over(BRAND.gold, hex.deepForest, 0.08)];
      for (const row of rows) {
        for (const [kind, pctWhole] of Object.entries(BADGE_EDGE_PCT)) {
          const pct = pctWhole / 100;
          const edge = over(hex.accentInk, row, pct);
          expect(
            contrast(edge, row),
            `${mode}: the ${kind} badge's ${pct * 100}% accentInk edge (${edge}) over row ${row}`,
          ).toBeGreaterThanOrEqual(CHROME_MIN_CONTRAST);
        }
        // …and the two weights must still be told apart, or the kind is carried by nothing.
        expect(
          contrast(over(hex.accentInk, row, BADGE_EDGE_PCT.prompt / 100), over(hex.accentInk, row, BADGE_EDGE_PCT.other / 100)),
          `${mode}: the two badge edge weights are indistinguishable over row ${row}`,
        ).toBeGreaterThanOrEqual(RAMP_MIN_SPLIT);
        // the label sits on the row itself, since the badge paints no fill
        expect(
          contrast(hex.accentInk, row),
          `${mode}: the badge label (${hex.accentInk}) on row ${row}`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });
});

describe("`mixedInk` — the orchestrator's mixed-workers disc", () => {
  // A 12px disc with no border, so this contrast IS its edge — same reasoning as the Send button
  // below, and the same 3:1 non-text floor. It is swept over all four planes rather than just the
  // build column's `deepForest`, because a status disc is rendered in the TopBar cluster and the
  // concierge digest too, and those sit on different surfaces.
  it("clears the non-text control floor on every plane, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const plane of PLANES) {
        expect(
          contrast(hex.mixedInk, hex[plane]),
          `${mode}: mixedInk (${hex.mixedInk}) on ${plane} (${hex[plane]})`,
        ).toBeGreaterThanOrEqual(CONTROL_MIN_CONTRAST);
      }
    }
  });

  // The whole point of the color is that it is neither of the two it sits between. If it drifts
  // close enough to red or green to be mistaken for one, the row silently reports a state it isn't
  // in — worse than having no mixed color at all, because it looks definite.
  it("stays distinguishable from the red and green it summarizes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const [name, other] of [
        ["red", AGENT_STATUS.waiting.color],
        ["green", AGENT_STATUS.working.color],
      ] as const) {
        expect(
          contrast(hex.mixedInk, other),
          `${mode}: mixedInk (${hex.mixedInk}) vs the ${name} dot (${other})`,
        ).toBeGreaterThanOrEqual(RAMP_MIN_SPLIT);
      }
    }
  });
});

// ── THE REST OF THE ACCENT FAMILY, THEMED ───────────────────────────────────────────────────────
// `accent`, `success`, `amber` and `sienna` each already had an ink twin; `teal` and `violet` did not, and
// passed through as brand literals on every plane in both themes. That is the same defect the four
// existing splits were each created to fix, so it is measured the same way rather than argued.
describe("`tealInk` / `violetInk` — the two brand accents that had no ink twin", () => {
  const NEW_INKS = ["tealInk", "violetInk"] as const;
  /** The brand literal each ink replaced, so a regression records WHAT it regressed to. */
  const BRAND_OF = { tealInk: BRAND.teal, violetInk: BRAND.violet } as const;

  it("each new ink clears AA on EVERY plane, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const ink of NEW_INKS) {
        for (const plane of PLANES) {
          expect(
            contrast(hex[ink], hex[plane]),
            `${mode}: ${ink} (${hex[ink]}) on ${plane} (${hex[plane]})`,
          ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
        }
      }
    }
  });

  it("the brand literals they replaced do NOT — which is why both tokens exist", () => {
    // Asserted as a FAILING measurement, in both themes, so neither token can be reverted to "the
    // brand colour is fine here". Note this is not a light-mode-only story the way `goldFill` was:
    // the black-and-gold repaint took dark's `forest` to near-black, and a saturated mid blue is
    // under the floor against THAT too.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const ink of NEW_INKS) {
        const worst = Math.min(...PLANES.map((p) => contrast(BRAND_OF[ink], hex[p])));
        expect(
          worst,
          `${mode}: brand ${ink.replace("Ink", "")} (${BRAND_OF[ink]}) at its worst plane`,
        ).toBeLessThan(INK_MIN_CONTRAST);
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

  // ── THE INACTIVE CHEVRON IS A SECOND FILL, AND IT WAS UNMEASURED ────────────────────────────────
  // PlanBuildToggle paints ONE `goldFill` and desaturates the inactive mode with `filter:
  // grayscale(1)`. The pair above measures the ACTIVE fill only, so the state the user is looking at
  // half the time had no floor at all (roborev 54002) — and the 0.9 opacity that used to ride along
  // with the filter made it worse, because opacity composites the label too: 5.17:1 became 4.28:1 in
  // light. The opacity is gone; this is the guard that keeps it gone.
  //
  // `grayscale(1)` is the CSS filter's own luminance matrix, not an average of the channels — the
  // difference is large enough here (#6d6d6d vs #567a7f-ish) that averaging would measure a colour
  // the browser never paints.
  //
  // BOTH SIDES GO THROUGH IT, because `filter` applies to the whole button — the LABEL as much as
  // the fill. It happens not to matter today (light's ink is #ffffff and dark's #090b14, both
  // near-neutral), but measuring an unfiltered ink against a filtered fill would be the exact
  // failure the paragraph above warns about, one token edit away (roborev 54025).
  const grayscale = (h: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    return `#${[y, y, y].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  };

  it("the GRAYSCALED chevron still clears AA against its label, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      const inactive = grayscale(hex.goldFill);
      const ink = grayscale(hex.onGoldFill);
      expect(
        contrast(ink, inactive),
        `${mode}: the grayscaled label (${ink}) on the grayscaled chevron (${inactive})`,
      ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
    }
  });

  // ── `DANGER` IS THEMED NOW, AND THAT IS WHY THESE TWO ASSERTIONS INVERTED ───────────────────────
  // The two tests that stood here pinned `DANGER` as a SHAPE colour: an unthemed brand red that
  // failed the ink floor on every light plane, and cleared the control floor on exactly one of
  // them. Both recorded a real defect — a dozen sites passed the constant straight to `color:` —
  // and both have been overtaken rather than deleted.
  //
  // The reason the old framing could not survive Blueprint: light `forest` stopped being white and
  // became the mid blue-grey TERMINAL plane, and `forest` is what roughly thirty dialogs and cards
  // paint. The constant measured 2.461 there, under the control floor, at every one of those sites
  // simultaneously — including `DefineStageModal`'s `1px solid DANGER` banner, whose own comment
  // claimed it cleared 3:1. The previous round "fixed" that by re-aiming the assertion at
  // `conciergeSurface`, a plane no DANGER border is drawn on, which turned the guard green while
  // the only real call site regressed. That is the failure this file's header exists to prevent,
  // and it is why the fix here is to the TOKEN, not to the assertion.
  //
  // `DANGER` is now `C.dangerInk` — the themed twin that already existed for this job. One change
  // fixed every call site, and the sweep below is what keeps it fixed: a future plane move is
  // caught by a measurement rather than by a reviewer reading thirty components.
  it("`DANGER` IS the themed ink — not a constant that call sites have to work around", () => {
    expect(DANGER).toBe(C.dangerInk);
    // and it resolves through the CSS layer rather than being a literal anyone can measure wrong
    expect(DANGER.startsWith("var(")).toBe(true);
  });

  it("`dangerInk` clears the INK floor on EVERY plane, in BOTH themes — the sweep DANGER now inherits", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const plane of PLANES) {
        expect(
          contrast(hex.dangerInk, hex[plane]),
          `${mode}: dangerInk (${hex.dangerInk}) on ${plane} (${hex[plane]})`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  it("the retired DANGER literal would still FAIL on the terminal plane — why the token had to move", () => {
    // Kept as a measurement, not a memory. If someone reintroduces `#e5484d` as alert ink because
    // "it used to be the brand red", this is the number that says no.
    expect(contrast("#e5484d", THEME_HEX.light.forest)).toBeLessThan(CONTROL_MIN_CONTRAST);
  });

  // `dangerInk`'s own floor is NOT restated here. It is already swept — deliberately scoped to the
  // surface it is read on by "the concierge column's themed INKS" above, whose comment explains at
  // length why an all-planes sweep for those tokens would assert a contract they were never given.
  // A second, broader copy here would supersede that decision silently and leave its rationale
  // paragraph standing as the stale advice the next reader acts on (roborev 54038). The modal
  // banner this pass repointed sits on `forest`, and OnePasswordPane's status pill and 12px error
  // text sit on `deepForest` — two planes that sweep does not reach (it is also read on
  // `conciergeSurface`, by NudgeCard, which is exactly what that sweep covers). Those two are measured
  // below, by the same rule it follows: the surfaces the ink is actually READ on, named. `forest`
  // alone would leave `deepForest` — the tightest of the four at 5.33:1 light — guarded nowhere
  // (roborev 54045), which is how a re-point that keeps the white modal comfortable slides the
  // settings dialog under the floor with the suite green.

  it("`dangerInk` clears AA on the two planes the concierge sweep does not reach", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const plane of ["forest", "deepForest"] as const) {
        expect(
          contrast(hex.dangerInk, hex[plane]),
          `${mode}: dangerInk (${hex.dangerInk}) on ${plane} (${hex[plane]})`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  // ── GOLD IS RETIRED. THE TOKENS ARE NOT. ──────────────────────────────────────────────────────
  // This test used to pin the four gold tokens to the prototype's literals and was named "the
  // repaint's whole point". That point has been reversed by the founder: Blueprint has ONE accent
  // and it is blue, so gold is gone from the shell entirely.
  //
  // The four token NAMES survive on purpose. They are threaded through a dozen call sites with a
  // documented three-role split (translucent tint / themed ink / opaque fill + its partner ink),
  // and that split is still exactly right — it is the HUE that changed, not the structure. Renaming
  // them is a mechanical sweep that would bury this behavioural change in a hundred-file diff.
  //
  // So the contract asserted here inverts: no gold anywhere, and the pair still holds its floors.
  //
  // TWO WAYS THIS GUARD USED TO BE WEAKER THAN ITS OWN STATED CONTRACT (roborev 54169), both fixed
  // below. It claimed to "fail loudly if someone reaches for warm again, in either direction", but:
  //   1. the retired-literal check was an exact, lowercase string match, so `#F5C26B` walked past
  //      it — and hex case is not something anyone thinks about while pasting a colour;
  //   2. the BRAND half pinned two dead literals with `not.toBe`, which `BRAND.gold = "#e0982f"`
  //      (or any other warm value) satisfies happily. BRAND.gold is what the translucent tints,
  //      the palette wash and the canvas sprites actually read, so it was the half most worth
  //      generalising and the only half that wasn't.
  // The blue-dominance check is the assertion that generalises, so it now covers BRAND too.
  const isBlue = (v: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
    return b > r && b > g;
  };
  it("the accent tokens carry BLUE, not gold — one accent, and it is not warm", () => {
    const RETIRED = ["#f5c26b", "#ffe9b8", "#090b14"];
    for (const mode of MODES) {
      for (const token of ["goldFill", "goldInk", "goldHotInk", "onGoldFill"] as const) {
        expect(
          RETIRED,
          `${mode}.${token} still carries a retired gold literal`,
        ).not.toContain(THEME_HEX[mode][token].toLowerCase());
      }
      // Blue means blue: the accent's blue channel dominates BOTH red and green at every end.
      for (const token of ["goldFill", "goldInk", "goldHotInk"] as const) {
        const v = THEME_HEX[mode][token];
        expect(isBlue(v), `${mode}.${token} (${v}) is not a blue`).toBe(true);
      }
    }
    // BRAND's own literals went with them — they are what the canvas star field reads. Held to the
    // same generalising check as the themed tokens, not to two dead literals.
    for (const [name, v] of [["gold", BRAND.gold], ["goldHot", BRAND.goldHot]] as const) {
      expect(RETIRED, `BRAND.${name} is back on a retired literal`).not.toContain(v.toLowerCase());
      expect(isBlue(v), `BRAND.${name} (${v}) is not a blue`).toBe(true);
    }
  });
});
