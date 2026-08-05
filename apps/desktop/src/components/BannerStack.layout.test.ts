// @vitest-environment jsdom
//
// ── THE REAL-LAYOUT PROOF FOR THE APP-SHELL BANNER STACK (bead sparkle-kk9dg.2) ────────────────
//
// The founder screenshotted the usage-limit banner showing only the MIDDLE of its own sentence.
// The reason a defect like that could ship is that a banner looks fine at 1200px and every test
// this repo had for it ran in jsdom — which has NO LAYOUT ENGINE. jsdom never wraps, never
// overflows and never clips, so `getBoundingClientRect()` is all zeroes and a test asserting
// "nothing is clipped" there measures nothing at all (docs/jsdom-test-caveats.md). This file
// exists so the claim is MEASURED.
//
// HOW IT MEASURES, and why it is this shape rather than a Playwright component test:
//
//   1. jsdom RENDERS. The three bars are store-driven React components, and every one of their
//      styles is INLINE — so the DOM jsdom produces carries the component's real styling verbatim,
//      with nothing re-spelled by hand. (SSR was tried first and is unusable: zustand v5 hands
//      `useSyncExternalStore` its INITIAL state as the server snapshot, so every banner
//      renderToStaticMarkup's to "" no matter what the store holds.)
//   2. REAL CHROME LAYS OUT. That markup is dropped into a replica of Workspace's `.shell` root —
//      `display:flex; flex-direction:column; height:100vh` with the flex:1 content row beneath, and
//      the app's own `index.css` inlined so the theme tokens and the body's `overflow:hidden`
//      resolve — and every box is measured with Chrome's own layout.
//
// WHAT IT ASSERTS is the SIDE EFFECT (the pixels), never the precondition: that no bar clips its
// own content on either axis, that the sentence's first line is never ABOVE the bar's top edge, and
// that neither the sentence's head nor its tail is pushed outside the box. The full sentence must
// also still be in the DOM — a fix that ellipsised the copy would satisfy every geometric
// assertion and destroy the banner's whole payload.
import { render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";

import { ProviderUnavailableBanner, PROVIDER_UNAVAILABLE_BAR_TESTID } from "./ProviderUnavailableBanner";
import { AiServiceBanner, AI_SERVICE_BAR_TESTID } from "./AiServiceBanner";
import { ZeroCreditBanner, ZERO_CREDIT_BAR_TESTID } from "./ZeroCreditBanner";
import { useAiProviderStore } from "../stores/aiProviderStore";
import { useAiServiceHealthStore } from "../stores/aiServiceHealthStore";
import { useAuthStore } from "../stores/authStore";
import { useUiStore } from "../stores/uiStore";

/** The exact copy each bar must render whole. Spelled out rather than imported: the point of the
 *  bead is that the SENTENCE reached the user intact, so the test states the sentence. */
const SENTENCES: Record<string, string> = {
  [PROVIDER_UNAVAILABLE_BAR_TESTID]:
    "Your Claude usage limit has been reached, so Sparkle's AI features are paused. They'll resume when it resets.",
  [AI_SERVICE_BAR_TESTID]:
    "AI-Enhanced features are paused — Claude is rate-limiting Sparkle's requests right now. We keep retrying automatically.",
  [ZERO_CREDIT_BAR_TESTID]:
    "Your Sparkle credit balance is $0. AI Enhanced features will no longer work.",
};

/**
 * The viewports this runs at, and why each one is here.
 *
 * 900×600 IS THE APP'S OWN MINIMUM, read off `src-tauri/tauri.conf.json` (`minWidth: 900`,
 * `minHeight: 600`) rather than invented — it is the smallest window the window manager will let a
 * user drag the shell to, so it is the binding "every window size the app permits" case.
 *
 * 560×700 is the founder's screenshot proportions: a tall, narrow shell where the sentence is
 * forced to wrap. This is where the bug was reported and where a centred bar's vertical overflow
 * would first have somewhere to go.
 *
 * 100×600 is BELOW anything the window manager allows, and it is in the list on purpose: it is the
 * width at which the pre-fix shape demonstrably breaks. Measured against the centred bars with
 * `min-width: auto` still on the sentence, the bar reported `scrollWidth > clientWidth` and the
 * sentence's left edge crossed outside the box — head and tail lost, middle surviving, which is
 * exactly the fragment the founder saw. Keeping it makes this suite go RED on a revert instead of
 * passing vacuously at widths where nothing was ever wrong.
 */
const VIEWPORTS = [
  { w: 900, h: 600, why: "the app's own minimum window (tauri.conf.json)" },
  { w: 560, h: 700, why: "narrow-and-tall, the founder's screenshot proportions" },
  { w: 100, h: 600, why: "below the window minimum — where the pre-fix shape breaks" },
] as const;

interface BarMetrics {
  testid: string;
  text: string;
  /**
   * END-EDGE overflow only — bottom and right. `scrollHeight`/`scrollWidth` describe the
   * SCROLLABLE overflow region, and the CSS overflow spec excludes *unreachable* overflow from it:
   * anything past the block-start or inline-start edge (top, and left in LTR) is simply not
   * counted, so `scrollHeight - clientHeight` reads 0 for content spilling ABOVE the box.
   *
   * That is the exact direction this file exists to prove, so these two CANNOT carry it — they are
   * the cheap end-edge half. {@link startEdgeSlackTop} / {@link startEdgeSlackLeft} are the
   * measurements that cover the start edges, and they are rect-based for precisely this reason.
   * (roborev 58696)
   */
  endOverflowV: number;
  endOverflowH: number;
  /**
   * The smallest gap between the bar's content-box TOP and any in-flow child's top, in px.
   * Negative = something is rendering above the bar's own padding edge, where an ancestor with
   * hidden overflow eats it. This is the assertion the bead is about.
   */
  startEdgeSlackTop: number;
  /** As above, for the content-box LEFT edge. Negative = content is off the left of the bar. */
  startEdgeSlackLeft: number;
  /**
   * The sentence's DECLARED font stack, with `var()` substituted — NOT the face Chrome actually
   * used. `getComputedStyle().fontFamily` cannot report the used face, and an earlier version of
   * this field claimed it did. The name matters because the assertion reads the FIRST entry:
   * membership is worthless here, since the way a webfont comes back is PREPENDED to the stack.
   * (roborev 58706/58707)
   */
  declaredFontFamily: string;
  /** First text line's top, minus the bar's own top. Negative = the line is ABOVE the bar. */
  firstLineOffsetFromTop: number;
  /** Sentence's left edge minus the bar's content-box left. Negative = the subject is off-box. */
  headSlack: number;
  /** Bar's content-box right minus the sentence's right edge. Negative = the tail is off-box. */
  tailSlack: number;
  /** The bar's top in viewport coordinates. Negative = the bar starts above the viewport. */
  viewportTop: number;
}

/** jsdom renders each banner; its `container.innerHTML` carries every inline style verbatim. */
function markup(el: ReactElement): string {
  return render(el).container.innerHTML;
}

/** A replica of Workspace's `.shell` root — the three properties the banner stack actually sits in
 *  (see Workspace.tsx's shell root) plus the `flex: 1; min-height: 0` content row beneath it. */
function shellPage(banners: string, css: string): string {
  return `<!doctype html><html data-theme="dark"><head>
    <style>${css}</style>
    <style>*{box-sizing:border-box}html,body,#root{height:100%;margin:0}body{overflow:hidden}</style>
  </head><body><div id="root"><div class="shell" style="display:flex;flex-direction:column;height:100vh;width:100vw">
    ${banners}
    <div data-testid="content-row" style="flex:1;display:flex;min-height:0"></div>
  </div></div></body></html>`;
}

/**
 * ── WHERE THIS RUNS, AND WHERE IT HONESTLY CANNOT ─────────────────────────────────────────────
 *
 * `playwright` is a devDependency whose BROWSER BINARIES are a separate download, and nothing in
 * `.github/workflows/ci.yml` installs them — which is the same reason `scripts/visual/` drives
 * system Chrome over raw CDP instead of using Playwright at all (see its README). So on CI, and on
 * any checkout that skipped `playwright install`, there is no Chromium here to lay anything out.
 *
 * The choice is between a suite that is RED everywhere it cannot measure, and one that says so and
 * stands down. It stands down — but never silently:
 *
 *   • the probe is SYNCHRONOUS and at collection time, so vitest REPORTS the block as skipped with
 *     its reason in the name, rather than a green run that quietly asserted nothing;
 *   • `SPARKLE_REQUIRE_BROWSER_TESTS=1` turns absence into a hard failure, for anyone who wires
 *     Chromium into CI later and wants the gate to bite;
 *   • the properties this file proves in pixels are ALSO pinned as style shape in
 *     ProviderUnavailableBanner/ZeroCreditBanner/AiServiceBanner's own jsdom tests, which need no
 *     browser and do run in CI. Those catch a revert; this one explains why the revert is wrong.
 *
 * A binary that EXISTS but fails to launch is a different fact — that is a real problem on a
 * machine that should be able to measure — so it fails loudly rather than skipping.
 */
const REQUIRE_BROWSER = process.env.SPARKLE_REQUIRE_BROWSER_TESTS === "1";

const chromiumPath: string | null = await (async () => {
  try {
    const { chromium } = await import("playwright");
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();

let browser: Browser | null = null;
/** Set when Chromium is installed but could not actually be launched — a hard failure, not a skip. */
let launchFailure: string | null = null;
let page = "";

beforeAll(async () => {
  useAiProviderStore.setState({ outage: { reason: "usage_limit", at: Date.now() } });
  useAiServiceHealthStore.setState({
    consecutiveFailures: 9,
    degraded: true,
    degradedAt: Date.now(),
    reason: "rate_limited",
    dismissed: false,
  });
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents: 0, tokenVersion: 1 },
  });
  useUiStore.setState({ zeroCreditBannerDismissed: false, zeroCreditBannerDismissedFor: null });

  // ALL THREE AT ONCE, which is the stacked case the bead asks about: the shell renders them as
  // siblings, so their combined height is what a short viewport has to absorb.
  const banners =
    markup(createElement(ZeroCreditBanner)) +
    markup(createElement(ProviderUnavailableBanner)) +
    markup(createElement(AiServiceBanner));
  // A guard on the FIXTURE, not on the app: if a store contract moved and a banner silently
  // rendered nothing, every geometric assertion below would pass against an empty page.
  for (const testid of Object.keys(SENTENCES)) {
    expect(banners, `${testid} must be in the stack — otherwise this suite measures nothing`).toContain(testid);
  }

  page = shellPage(banners, readFileSync(resolve(import.meta.dirname, "../index.css"), "utf8"));

  if (!chromiumPath) return;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (e) {
    launchFailure = e instanceof Error ? e.message : String(e);
  }
}, 120_000);

// An explicit timeout, because the DEFAULT (10s) is not enough. Closing Chromium is a process
// teardown, and this file runs alongside the rest of the largest suite in the repo — under that
// contention the close overran 10s and failed the whole FILE while all 13 tests had passed, which
// is the most confusing possible red.
afterAll(async () => {
  await browser?.close();
}, 60_000);

async function measure(w: number, h: number): Promise<BarMetrics[]> {
  const p = await browser!.newPage({ viewport: { width: w, height: h } });
  try {
    await p.setContent(page);
    return await p.evaluate((ids: string[]) => {
      return ids.map((testid) => {
        // NAMED failures, not an opaque "Cannot read properties of null" from the cast below.
        // This is where a bar can genuinely go missing — it is in the laid-out page or it is not —
        // so this is the check, rather than a count compared against the same list that produced
        // the result. (roborev 58701)
        const bar = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
        if (!bar) throw new Error(`${testid} is not in the laid-out page`);
        const span = bar.querySelector("span[role=status]") as HTMLElement | null;
        if (!span) throw new Error(`${testid} has no role=status sentence to measure`);
        const barBox = bar.getBoundingClientRect();
        const spanBox = span.getBoundingClientRect();
        const cs = getComputedStyle(bar);
        const padL = parseFloat(cs.paddingLeft);
        const padR = parseFloat(cs.paddingRight);
        const padT = parseFloat(cs.paddingTop);
        // The first LINE, not the span: a wrapped span's box spans every line, so its top is the
        // top of line 1 while its height covers them all. Range rects give line 1 on its own.
        const range = document.createRange();
        range.selectNodeContents(span);
        const firstLine = range.getClientRects()[0] ?? spanBox;

        // THE START EDGES, measured with rects because the scroll metrics are blind to them.
        // Every IN-FLOW child (the out-of-flow ✕ is pinned to the bar's middle by design and is
        // not part of the flow being measured), so this catches an icon riding up above the
        // padding edge just as well as the sentence doing it.
        const inFlow = (Array.from(bar.children) as HTMLElement[]).filter(
          (c) => getComputedStyle(c).position !== "absolute",
        );
        const childBoxes = inFlow.map((c) => c.getBoundingClientRect());
        // The first line's own rect is included: a wrapped span's BOX starts at line 1, but this
        // keeps the measurement true if that ever stops holding.
        const tops = [...childBoxes.map((b) => b.top), firstLine.top];
        const lefts = [...childBoxes.map((b) => b.left), firstLine.left];

        return {
          testid,
          text: (span.textContent ?? "").trim(),
          endOverflowV: bar.scrollHeight - bar.clientHeight,
          endOverflowH: bar.scrollWidth - bar.clientWidth,
          startEdgeSlackTop: Math.min(...tops) - (barBox.top + padT),
          startEdgeSlackLeft: Math.min(...lefts) - (barBox.left + padL),
          firstLineOffsetFromTop: firstLine.top - barBox.top,
          headSlack: spanBox.left - (barBox.left + padL),
          tailSlack: barBox.right - padR - spanBox.right,
          viewportTop: barBox.top,
          declaredFontFamily: getComputedStyle(span).fontFamily,
        };
      });
    }, Object.keys(SENTENCES));
  } finally {
    await p.close();
  }
}

// ALWAYS RUNS, in every environment, so the absence of a browser is a REPORTED fact rather than an
// empty run nobody notices. It only turns absence into a failure under SPARKLE_REQUIRE_BROWSER_TESTS.
describe("real-layout coverage for the banner stack", () => {
  it("has a Chromium to measure with, or is deliberately standing down", () => {
    if (!chromiumPath) {
      const how = "pnpm --filter @sparkle/desktop exec playwright install chromium";
      if (REQUIRE_BROWSER) {
        expect.fail(
          `SPARKLE_REQUIRE_BROWSER_TESTS=1 but Playwright's Chromium is not installed. Run: ${how}`,
        );
      }
      console.warn(
        `[BannerStack.layout] STANDING DOWN — Playwright's Chromium is not installed, so the ` +
          `real-layout assertions are skipped. The style-shape guards in the three banners' own ` +
          `tests still run. To measure here: ${how}`,
      );
    }
    // A binary that exists but will not launch is a real problem on a machine that should be able
    // to measure, so that case is never a skip — it fails, here, with the launcher's own message.
    expect(launchFailure, "Chromium is installed but failed to launch").toBeNull();
  });
});

describe.skipIf(!chromiumPath)("app-shell banner stack, measured in real Chrome", () => {
  for (const { w, h, why } of VIEWPORTS) {
    describe(`${w}×${h} — ${why}`, () => {
      let bars: BarMetrics[] = [];

      beforeAll(async () => {
        // Every assertion below iterates `bars`, so an empty result would satisfy all of them
        // while measuring nothing. Two things stop that, in order:
        //
        //   1. the FIXTURE guard in the file-level beforeAll, which fails if a banner is missing
        //      from the rendered markup. It compares two independently-sourced things — the
        //      markup the components produced, and the exported testid constants — so it is
        //      genuinely falsifiable: deleting a bar's `data-testid` makes it fail (verified by
        //      mutation, and it is what fires first);
        //   2. the named throws inside `measure`, for the narrower case where the string is in
        //      the markup but no element is in the LAID-OUT page. Those buy a named failure in
        //      place of an opaque "Cannot read properties of null".
        //
        // A `bars.length === Object.keys(SENTENCES).length` assertion was tried here and REMOVED:
        // `measure` builds its result by mapping over that very array, so both sides move
        // together and the assertion is an identity that cannot fail — the same vacuous shape it
        // was written to prevent, with a comment claiming protection it did not provide.
        // (roborev 58701)
        bars = await measure(w, h);
      }, 60_000);

      it("pushes nothing past its bottom or right edge", () => {
        for (const b of bars) {
          // The END-EDGE half only. These are scroll metrics, and the CSS overflow spec keeps
          // unreachable (top/left) overflow OUT of the scrollable region — so a green here says
          // nothing whatsoever about the direction the bead reported. The next test is the one
          // that covers that. (roborev 58696)
          expect(b.endOverflowV, `${b.testid} overflows its bottom at ${w}×${h}`).toBeLessThanOrEqual(0);
          expect(b.endOverflowH, `${b.testid} overflows its right at ${w}×${h}`).toBeLessThanOrEqual(0);
        }
      });

      it("pushes nothing past its TOP or LEFT edge — the direction the bug was reported in", () => {
        for (const b of bars) {
          // Rect-based, because this is precisely what `scrollHeight`/`scrollWidth` cannot see.
          // A centred bar shorter than its content overflows EQUALLY at both ends, and the top
          // half is then eaten by an ancestor that hides overflow — "the subject is cut off above
          // the viewport", with the reader unable to tell what the banner is even about.
          // Sub-pixel rounding on a centred line can leave a fraction; -1 is that tolerance and
          // nothing else. The failure this guards against is whole lines and whole words.
          expect(
            b.startEdgeSlackTop,
            `${b.testid} renders ${-b.startEdgeSlackTop}px above its own top padding edge at ${w}×${h}`,
          ).toBeGreaterThan(-1);
          expect(
            b.startEdgeSlackLeft,
            `${b.testid} renders ${-b.startEdgeSlackLeft}px left of its own left padding edge at ${w}×${h}`,
          ).toBeGreaterThan(-1);
        }
      });

      it("measures in the font the app actually ships, not a fallback", () => {
        for (const b of bars) {
          // Glyph advance widths decide where the sentence wraps and whether it overflows, so a
          // measurement taken in the wrong face proves nothing about the shipped app. Today the
          // bars declare the SYSTEM stack (`--k-ui`; index.css: "nothing asks for IBM Plex by name
          // any more"), which needs no webfont load — so there is no `@font-face` to resolve and
          // no swap to race, and the page's `about:blank` base URL costs nothing.
          //
          // THE FIRST ENTRY, not membership. A webfont comes back by being PREPENDED —
          // `"IBM Plex Sans", system-ui, -apple-system, …`, literally the pre-Blueprint value —
          // and index.css still ships four @font-face blocks whose relative `./fonts/*.woff2` are
          // unresolvable under this page's base URL. A `toContain("system-ui")` check passes in
          // exactly that state, so it would have been vacuous for the one regression it names:
          // the suite would measure in the fallback face and still report green.
          // (roborev 58706/58707)
          const first = b.declaredFontFamily.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
          expect(
            first,
            `${b.testid} leads with "${first}" (stack: ${b.declaredFontFamily}) — if the UI font ` +
              `is a webfont again, this harness must serve it over a real base URL and await ` +
              `document.fonts.ready before any measurement here means anything`,
          ).toBe("system-ui");
        }
      });

      it("never puts the sentence's first line above the bar's top edge", () => {
        for (const b of bars) {
          // THE SUBJECT OF THE SENTENCE IS THE PAYLOAD. A centred bar shorter than its content
          // pushes line 1 to a NEGATIVE offset, where an ancestor with hidden overflow eats it —
          // which is precisely "the first half is cut off above the viewport".
          expect(
            b.firstLineOffsetFromTop,
            `${b.testid}'s first line sits ${b.firstLineOffsetFromTop}px above its own bar at ${w}×${h}`,
          ).toBeGreaterThanOrEqual(0);
          expect(b.viewportTop, `${b.testid} starts above the viewport at ${w}×${h}`).toBeGreaterThanOrEqual(0);
        }
      });

      it("keeps both the head and the tail of the sentence inside the bar", () => {
        for (const b of bars) {
          // Sub-pixel rounding on a centred flex line can leave a fraction either way; -1 is the
          // tolerance for that and nothing else. The failure this guards against is whole words.
          expect(b.headSlack, `${b.testid} pushes its subject off the left at ${w}×${h}`).toBeGreaterThan(-1);
          expect(b.tailSlack, `${b.testid} pushes its tail off the right at ${w}×${h}`).toBeGreaterThan(-1);
        }
      });

      it("still carries the whole sentence — wrapping is fine, truncation is not", () => {
        for (const b of bars) {
          expect(b.text, `${b.testid} lost part of its copy at ${w}×${h}`).toBe(SENTENCES[b.testid]);
        }
      });
    });
  }
});
