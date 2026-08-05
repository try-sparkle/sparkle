// Tests for the visual harness's pure logic — the PNG codec, the diff arithmetic, and the surface
// registry. Everything that touches Chrome is excluded on purpose: those parts are proven by
// actually running `visual:capture`, while THESE are the parts whose silent misbehaviour would
// produce a confident, wrong number.
//
// Picked up by the desktop vitest run (its default include covers scripts/), so
// `pnpm --filter @sparkle/desktop test` exercises them.

import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { Script, createContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONCIERGE_DEFAULT_WIDTH, CONCIERGE_MIN_WIDTH } from "../../src/engine/columnResize.ts";
import { visualCaptureRun, visualFixturesRequested } from "../../src/dev/visualFixtures.ts";
import { decodePng, encodePng } from "./png.mjs";
import { blank, blit, compareImages, diffImage, sideBySide } from "./diff.mjs";
import {
  SURFACES,
  THEMES,
  artifactName,
  selectSurfaces,
  stepToExpression,
  surfaceByName,
} from "./surfaces.mjs";
import { INIT_SCRIPTS, numericArg, parseArgs, surfaceUrl } from "./capture.mjs";
import { CLEAR_STORAGE } from "./serve.mjs";
import { MOCK_REL, mockChromeCss, resolveMock, viewportFromManifest } from "./compare.mjs";
import { compareDirs, shouldKeep } from "./verify-stable.mjs";
import {
  channelDelta,
  parseArgs as probeArgs,
  parseRange,
  probeOptions,
  probeRows,
  runsOf,
  scanRow,
  toHex,
  verdict,
  wantsStrict,
} from "./seam-probe.mjs";
import { crop } from "./crop.mjs";
import {
  DEFAULT_WIDTHS,
  EDGE_TOLERANCE,
  HYBRID_MIN_WIDTH,
  MAX_ROW_LINES,
  parseArgs as recapArgs,
  parseWidths as recapWidths,
  verdictFor as recapVerdict,
} from "./recap-narrow-probe.mjs";

/** A tiny image with a known pixel at (x, y). */
function img(width, height, fill = [0, 0, 0, 255]) {
  return blank(width, height, fill);
}

function setPx(image, x, y, [r, g, b, a = 255]) {
  const i = (y * image.width + x) * 4;
  image.data[i] = r;
  image.data[i + 1] = g;
  image.data[i + 2] = b;
  image.data[i + 3] = a;
  return image;
}

describe("png codec", () => {
  it("round-trips RGBA pixels exactly", () => {
    const src = img(7, 5, [10, 20, 30, 255]);
    setPx(src, 0, 0, [255, 0, 0]);
    setPx(src, 6, 4, [0, 255, 128]);
    const out = decodePng(encodePng(src));
    expect(out.width).toBe(7);
    expect(out.height).toBe(5);
    expect(Buffer.compare(out.data, src.data)).toBe(0);
  });

  it("encodes deterministically — the same pixels give the same bytes", () => {
    // A byte-stable harness needs a byte-stable encoder, or re-running compare churns artifacts.
    const a = encodePng(img(9, 9, [1, 2, 3, 255]));
    const b = encodePng(img(9, 9, [1, 2, 3, 255]));
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it("decodes a real Chrome-shaped PNG (8-bit RGB, no alpha channel)", () => {
    // Chrome emits colour type 2 for opaque captures; the decoder must widen it to RGBA rather
    // than mis-striding, which would shear the image and score ~100% against everything.
    const rgb = buildRgbPng(3, 2, [200, 100, 50]);
    const out = decodePng(rgb);
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    expect([...out.data.subarray(0, 4)]).toEqual([200, 100, 50, 255]);
  });

  it("rejects input that is not a PNG", () => {
    expect(() => decodePng(Buffer.from("definitely not a png"))).toThrow(/signature/i);
  });
});

/** Hand-build a colour-type-2 (RGB) PNG so the decoder is tested against something it didn't write. */
function buildRgbPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "ascii");
    body.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("compareImages", () => {
  it("reports 0% for identical images", () => {
    const a = img(10, 10, [5, 5, 5, 255]);
    const b = img(10, 10, [5, 5, 5, 255]);
    const r = compareImages(a, b);
    expect(r.percent).toBe(0);
    expect(r.overlapPercent).toBe(0);
    expect(r.sameSize).toBe(true);
    expect(r.maxDelta).toBe(0);
  });

  it("reports 100% when every pixel differs", () => {
    const r = compareImages(img(4, 4, [0, 0, 0, 255]), img(4, 4, [255, 255, 255, 255]));
    expect(r.percent).toBe(100);
    expect(r.maxDelta).toBe(255);
  });

  it("counts exactly the pixels that differ", () => {
    const a = img(10, 10, [0, 0, 0, 255]);
    const b = img(10, 10, [0, 0, 0, 255]);
    setPx(b, 1, 1, [255, 255, 255]);
    setPx(b, 2, 2, [255, 255, 255]);
    const r = compareImages(a, b);
    expect(r.differing).toBe(2);
    expect(r.percent).toBe(2); // 2 of 100
  });

  it("honours the per-channel threshold", () => {
    const a = img(4, 4, [100, 100, 100, 255]);
    const b = img(4, 4, [103, 100, 100, 255]); // delta of 3 on one channel
    expect(compareImages(a, b).percent).toBe(100);
    expect(compareImages(a, b, { threshold: 3 }).percent).toBe(0);
    expect(compareImages(a, b, { threshold: 2 }).percent).toBe(100);
  });

  it("treats a size mismatch as differing, over the union area", () => {
    // THE LOAD-BEARING CASE. The app and the mock are routinely different sizes, and that IS the
    // finding — so non-overlap must count as difference rather than being quietly cropped away.
    const a = img(10, 10, [0, 0, 0, 255]);
    const b = img(10, 5, [0, 0, 0, 255]); // half the height, identical where they overlap
    const r = compareImages(a, b);
    expect(r.sameSize).toBe(false);
    expect(r.total).toBe(100); // union: 10×10
    expect(r.differing).toBe(50); // the 50 pixels b does not cover
    expect(r.percent).toBe(50);
    // ...while the shared region is a perfect match, which is the other half of the story.
    expect(r.overlap).toBe(50);
    expect(r.overlapPercent).toBe(0);
  });

  it("separates a size mismatch from a colour mismatch", () => {
    const a = img(10, 10, [0, 0, 0, 255]);
    const b = img(10, 5, [255, 255, 255, 255]);
    const r = compareImages(a, b);
    expect(r.percent).toBe(100); // wrong size AND wrong colour
    expect(r.overlapPercent).toBe(100);
  });

  it("ignores alpha, comparing colour channels only", () => {
    const a = img(4, 4, [10, 20, 30, 255]);
    const b = img(4, 4, [10, 20, 30, 0]);
    expect(compareImages(a, b).percent).toBe(0);
  });
});

describe("composition", () => {
  it("lays the two images side by side with a gutter", () => {
    const out = sideBySide(img(10, 20), img(30, 5), { gutter: 4 });
    expect(out.width).toBe(10 + 4 + 30);
    expect(out.height).toBe(20); // the taller of the two
  });

  it("blits within bounds and clips the overflow", () => {
    const dst = img(4, 4, [0, 0, 0, 255]);
    const src = img(3, 3, [255, 255, 255, 255]);
    blit(dst, src, 2, 2); // only a 2×2 corner lands
    const white = (x, y) => dst.data[(y * 4 + x) * 4] === 255;
    expect(white(3, 3)).toBe(true);
    expect(white(1, 1)).toBe(false);
  });

  it("paints differing pixels in the highlight colour and matching ones as a ghost", () => {
    const a = img(2, 1, [0, 0, 0, 255]);
    const b = img(2, 1, [0, 0, 0, 255]);
    setPx(b, 1, 0, [255, 255, 255]);
    const d = diffImage(a, b);
    expect([...d.data.subarray(4, 7)]).toEqual([255, 0, 200]); // pixel 1 differs → magenta
    expect(d.data[0]).toBe(d.data[1]); // pixel 0 matches → gray ghost
    expect(d.data[0]).toBeGreaterThan(0); // ...lifted, not black
  });

  it("marks non-overlapping area as differing in the diff image too", () => {
    const d = diffImage(img(2, 2, [0, 0, 0, 255]), img(1, 1, [0, 0, 0, 255]));
    expect(d.width).toBe(2);
    // (1,1) is outside the smaller image entirely → highlighted.
    expect([...d.data.subarray((1 * 2 + 1) * 4, (1 * 2 + 1) * 4 + 3)]).toEqual([255, 0, 200]);
  });
});

describe("surface registry", () => {
  it("names every surface the task requires, in both themes", () => {
    const names = SURFACES.map((s) => s.name);
    expect(names).toEqual([
      "workspace-unwired",
      "workspace-wired-left",
      "workspace-wired-right",
      "agent-sidebar",
      // The queued-instruction badge, OPENED (bead sparkle-zm0c8). A concierge message queued for an
      // agent used to render nowhere, so "I sent it" was uncheckable; the badge's popover is where
      // the queued text and the three delivery stages live. App-only — the approved rev4 mock
      // predates the affordance entirely, so this is a regression baseline rather than a fidelity
      // comparison. Carries `inbox=1` so the seed stays off every other surface's capture.
      "inbox-popover",
      "concierge-column",
      // The voice surfaces, added when the wake word was retired. `settings-voice` photographs the
      // Settings section the founder asked to have emptied; the three `send-tray-*` ones photograph
      // each tray position's own copy, which is what the retirement rewrote.
      "settings-voice",
      "send-tray-speak",
      "send-tray-ptt",
      // The live Deepgram preview, mid-utterance — the state a push-to-talk HOLD produces, as
      // opposed to `send-tray-ptt`'s between-holds rest. It is the only surface that photographs
      // provisional (italic) transcript ink.
      "composer-interim",
      "send-tray-send",
      "settings-dialog",
      "open-pr-menu-narrow",
      "open-pr-menu-grouped-narrow",
      "open-pr-menu-grouped-wide",
      // The merge-rights + dismissal surfaces (bead sparkle-j881r). Two states no other surface
      // reaches: a green PR with a DISABLED Merge because the user has no write access in that
      // repo, and the Dismissed section EXPANDED. Both are new content in an already-crowded row,
      // which is where this menu has regressed twice — and both times a photograph caught it.
      "open-pr-menu-dismissed-wide",
      "open-pr-menu-dismissed-narrow",
    ]);
    expect(THEMES).toEqual(["light", "dark"]);
  });

  // THE SURFACE THAT NEEDS TWO PAIRS MUST ASK FOR THEM. Without `?pairs=2` the fixture seeds one
  // project, the left pair has no selected agent, `useEffectiveWired` refuses to project that side,
  // and this surface photographs the unwired app — which is exactly what it did for its whole life.
  it("asks the fixture for the second pair on the surface that needs it", () => {
    expect(surfaceByName("workspace-wired-left").query).toBe("pairs=2");
    // …and NO OTHER SURFACE OPENS A SECOND PAIR, which is the invariant — a second pair re-lays-out
    // the whole shell, so every other baseline would move.
    //
    // Asserted on the `pairs` PARAMETER, not on `query` being absent entirely, which is what this
    // checked first. That was a fair proxy while `pairs` was the only parameter in existence and
    // stopped being one the moment a second was added: `open-pr-menu-narrow` carries `prs` and
    // `concierge`, neither of which opens a pair, and the proxy would have refused it. Guard the
    // fact, not the shape it happened to have.
    for (const s of SURFACES.filter((x) => x.name !== "workspace-wired-left")) {
      const pairs = new URLSearchParams(s.query ?? "").get("pairs");
      expect(pairs, `${s.name} must not open a second pair`).toBeNull();
    }
  });

  // A SURFACE'S PARAMETERS ARE ITS ONLY WAY TO REACH STATE THE FIXTURE MUST SEED BEFORE MOUNT, so
  // a typo in one is silent: the app boots in its DEFAULT state and the capture is filed under a
  // name claiming otherwise. That is the mislabelled-screenshot failure this harness has hit twice
  // (the `data-wired` attribute, and the theme write that observed itself). Pin the two the PR-menu
  // surface depends on — without `prs` there is no badge to click, and without `concierge` the
  // column is at its comfortable 380px default, which is the width the bug is invisible at.
  it("asks for the PRs and the narrow column the open-PR surface is about", () => {
    const q = new URLSearchParams(surfaceByName("open-pr-menu-narrow").query);
    expect(q.get("prs")).toBe("1");
    expect(Number(q.get("concierge"))).toBeLessThan(380);
  });

  // THE GROUPED PAIR ASKS FOR THE SECOND PROJECT, AND ONLY THEY DO. Same reasoning as the test
  // above: a parameter a surface forgets to carry is silent — the app boots single-project, the
  // menu has one section, and the capture is filed under a name promising a grouped one.
  //
  // BOTH SURFACES NAME THEIR COLUMN WIDTH. This block used to say the opposite — that the wide shot
  // must NOT carry a `concierge` width, since writing nothing yields the app's default — and that
  // reasoning is what produced two byte-identical PNGs. `localStorage` outlives a navigation, so a
  // width-less surface inherited the previous one's column instead. The fixture now clears the keys
  // when no width is asked for, so "nothing" means the default again; naming both widths anyway is
  // the belt to that braces, and keeps each surface's meaning legible from its own query.
  //
  // The pair only separates CONTAINMENT (the panel escapes a squeezed column) from CONTENT (the
  // groups read correctly with room) if the two widths are genuinely far apart, so both ends are
  // bounded below — narrow squeezed, wide at least the app's own default.
  it("asks for a second project on the two grouped open-PR surfaces, and nowhere else", () => {
    // Every surface that needs a MULTI-REPO menu. The dismissal pair is here for the same reason
    // the grouped pair is: the panel only groups once a second project tab is open, and the
    // Dismissed section names the project each hidden row came from — which says nothing at all
    // when there is only one project it could be.
    const grouped = [
      "open-pr-menu-grouped-narrow",
      "open-pr-menu-grouped-wide",
      "open-pr-menu-dismissed-wide",
      "open-pr-menu-dismissed-narrow",
    ];
    for (const name of grouped) {
      const q = new URLSearchParams(surfaceByName(name).query);
      expect(q.get("projects"), `${name} must open the second project`).toBe("2");
      expect(q.get("prs"), `${name} needs PRs to have a badge to click`).toBe("1");
    }
    for (const s of SURFACES.filter((x) => !grouped.includes(x.name))) {
      const projects = new URLSearchParams(s.query ?? "").get("projects");
      expect(projects, `${s.name} must not open a second project`).toBeNull();
    }
    // ── BOTH MUST NAME A WIDTH, AND THE NARROW ONE MUST BE NARROWER ───────────────────────────
    //
    // This assertion used to require the WIDE surface to carry NO `concierge` parameter, on the
    // reasoning that writing nothing yields the app's own default. That is true only of a cold
    // profile, and the capture harness drives every surface through ONE browser context — so
    // `sparkle-concierge-width` survives from surface to surface and a width-less surface inherits
    // whatever the previously-captured one left behind. Captured straight after the narrow surface,
    // the "wide" one photographed a 190px column and the two PNGs came out BYTE-IDENTICAL: a pair
    // that is supposed to isolate containment from content, silently testing one width twice.
    //
    // So the invariant is not "one states a width and one does not". It is that BOTH state one, so
    // neither depends on capture order, and that they are genuinely different widths.
    const widthOf = (name) => {
      const raw = new URLSearchParams(surfaceByName(name).query).get("concierge");
      expect(raw, `${name} must state its concierge width rather than inherit one`).not.toBeNull();
      return Number(raw);
    };
    const [narrowW, wideW] = [widthOf(grouped[0]), widthOf(grouped[1])];
    expect(narrowW, "the narrow surface must be squeezed").toBeLessThan(380);
    expect(narrowW, "the pair is pointless at one width").toBeLessThan(wideW);
    // A LOWER BOUND ON THE WIDE END, because "they differ" is not the property this pair needs.
    // narrow=190 / wide=200 satisfies both lines above and is two squeezed captures — the panel
    // clipped in each — with one of them still filed as "at the default concierge width". Sourced
    // from the app's own constant rather than re-spelled as a literal, for the reason
    // `visualConciergeWidth`'s docblock already argues: a second spelling of a bound is a bound
    // that can silently disagree with the first.
    expect(wideW, "the wide surface must be at a comfortable width").toBeGreaterThanOrEqual(
      CONCIERGE_DEFAULT_WIDTH,
    );
  });

  it("gives every surface app steps, and a mock half or an explicit null", () => {
    for (const s of SURFACES) {
      expect(Array.isArray(s.app.steps), `${s.name} has app steps`).toBe(true);
      expect(s.app.steps.length, `${s.name} has at least one app step`).toBeGreaterThan(0);
      // `undefined` would read as an oversight; `null` is a recorded decision.
      expect(s.mock === null || typeof s.mock === "object", `${s.name} mock is null or an object`)
        .toBe(true);
      if (s.mock) expect(typeof s.mock.clip).toBe("string");
    }
  });

  // ── THE CLIP THAT MUST STAY NULL, AS A MECHANISM RATHER THAN A COMMENT ──────────────────────
  //
  // `inbox-popover` is the only surface that seeds an inbox, so its capture is the ONLY place the
  // on-row badge is photographed — and the badge is the primary artifact of bead sparkle-zm0c8
  // ("which of my agents are holding instructions" is a column question).
  //
  // Clipping to the popover silently deletes that. The panel is a `position: fixed` portal at
  // `top: anchor.bottom + 6`, so its box begins strictly BELOW the chip: a popover-scoped clip
  // excludes the badge by construction, and a column-scoped one fails too because the portal is not
  // in the column's subtree. That is not hypothetical — it shipped exactly once, and the whole suite
  // stayed green, because nothing here inspects `app.clip` at all (only `mock.clip`). The reasoning
  // lived in a source comment, which is not a mechanism (roborev 58034).
  //
  // Pinned by NAME rather than as a blanket rule: `clip: null` is wrong for most surfaces — a
  // full-viewport shot of a component scores layout noise as component drift. This one earns it.
  it("keeps inbox-popover's clip null, so the badge stays in its own capture", () => {
    const s = surfaceByName("inbox-popover");
    expect(
      s.app.clip,
      "inbox-popover must capture the FULL VIEWPORT. Its popover is a fixed-position portal at " +
        "anchor.bottom + 6, so any clip scoped to the popover excludes the on-row badge by " +
        "construction — and since this is the only surface that seeds an inbox, that leaves the " +
        "badge photographed nowhere. Use the `inFrame` step to assert both are in the picture.",
    ).toBe(null);
    // …and the step that replaces the clip's geometry check is still there. Without it the null clip
    // is a capture with NO box assertion at all, which is the other half of the same defect.
    expect(
      s.app.steps.some((step) => step.inFrame),
      "inbox-popover must keep an `inFrame` step: a null clip gives up the box check a clip " +
        "performs, and `waitFor` proves DOM presence only — an element below the fold satisfies it " +
        "while the PNG contains none of it.",
    ).toBe(true);
  });

  it("has unique surface names — artifacts are keyed on them", () => {
    expect(new Set(SURFACES.map((s) => s.name)).size).toBe(SURFACES.length);
  });

  it("resolves and filters surfaces by name", () => {
    expect(selectSurfaces(null)).toHaveLength(SURFACES.length);
    // Back in the default set now that the fixture can seed a left pair via `?pairs=2`.
    expect(selectSurfaces(null).map((s) => s.name)).toContain("workspace-wired-left");
    expect(selectSurfaces("agent-sidebar").map((s) => s.name)).toEqual(["agent-sidebar"]);
    expect(selectSurfaces("agent-sidebar, concierge-column")).toHaveLength(2);
    expect(surfaceByName("agent-sidebar").name).toBe("agent-sidebar");
    expect(() => surfaceByName("nope")).toThrow(/Unknown surface "nope"/);
  });

  it("names artifacts as <surface>-<theme>.png", () => {
    expect(artifactName("agent-sidebar", "dark")).toBe("agent-sidebar-dark.png");
  });
});

describe("step compilation", () => {
  it("compiles each verb to an expression mentioning its selector", () => {
    expect(stepToExpression({ waitFor: ".x" })).toContain('".x"');
    expect(stepToExpression({ click: ".y" })).toContain(".click()");
    expect(stepToExpression({ clickText: { sel: "li", t: "Settings" } })).toContain('"Settings"');
    const attr = stepToExpression({ setAttr: { sel: "#s", name: "data-wired", value: "left" } });
    expect(attr).toContain('"data-wired"');
    expect(attr).toContain('"left"');
  });

  // ── THE `inFrame` RECT LOGIC, RUN RATHER THAN READ ──────────────────────────────────────────
  //
  // Every other test here asserts the compiled expression's TEXT, which cannot tell a correct rect
  // check from `return true`. That gap is not theoretical: gutting this verb's comparison to
  // `return true` left the whole suite green, so the verb protecting `inbox-popover` from a silent
  // pass was itself unprotected against exactly the failure it exists to catch.
  //
  // So this EVALUATES the generated expression against fake geometry. The below-the-fold case is the
  // one that matters — `captureBeyondViewport: false` means such an element is absent from the PNG
  // while `waitFor` is perfectly satisfied — and it is the shape `inbox-popover` can actually reach,
  // since its panel is fixed at `anchor.bottom + 6` with no vertical flip.
  it("passes only when every named element is really inside the viewport", () => {
    const evaluate = (boxes) => {
      const expr = stepToExpression({ inFrame: Object.keys(boxes) });
      const document = { querySelector: (s) => (boxes[s] ? { getBoundingClientRect: () => boxes[s] } : null) };
      return new Function("document", "window", `return ${expr}`)(document, { innerHeight: 900 });
    };
    const ok = { height: 20, width: 40, top: 100, bottom: 120 };

    expect(evaluate({ ".a": ok }), "a fully visible element passes").toBe(true);
    expect(evaluate({ ".a": ok, ".b": { ...ok, top: 300, bottom: 340 } }), "…and so do two").toBe(true);

    // BELOW THE FOLD — present in the DOM, absent from the screenshot. The whole point of the verb.
    expect(evaluate({ ".a": { ...ok, top: 880, bottom: 940 } }), "below the fold must FAIL").toBe(false);
    // Above it, too: a fixed panel can be pushed off the top edge just as easily.
    expect(evaluate({ ".a": { ...ok, top: -30, bottom: 10 } }), "above the fold must FAIL").toBe(false);
    // Zero-area: rendered, laid out, and photographs as nothing.
    expect(evaluate({ ".a": { ...ok, height: 0 } }), "zero height must FAIL").toBe(false);
    expect(evaluate({ ".a": { ...ok, width: 0 } }), "zero width must FAIL").toBe(false);
    // Absent entirely.
    expect(evaluate({ ".missing": null }), "an unmatched selector must FAIL").toBe(false);
    // EVERY, not SOME: one good element must not carry a bad one into the frame.
    expect(
      evaluate({ ".a": ok, ".b": { ...ok, top: 880, bottom: 940 } }),
      "one visible element must not excuse an off-screen sibling",
    ).toBe(false);
  });

  it("escapes selectors rather than splicing them in raw", () => {
    // A selector containing a quote must not be able to break out of the generated expression.
    const expr = stepToExpression({ waitFor: '[title="a\\"b"]' });
    expect(() => new Function(`return ${expr}`)).not.toThrow();
  });

  it("refuses an unrecognised step instead of silently skipping it", () => {
    expect(() => stepToExpression({ nope: true })).toThrow(/Unrecognised step/);
  });

  it("every registry step uses a known verb", () => {
    for (const s of SURFACES) {
      for (const step of s.app.steps) expect(() => stepToExpression(step)).not.toThrow();
      for (const step of s.mock?.steps ?? []) expect(() => stepToExpression(step)).not.toThrow();
    }
  });
});

describe("the cable step asserts the SHELL agrees, not just that it called the store", () => {
  // THE BUG THIS GUARDS. The step used to return true as soon as `__sparkleCable(side)` had been
  // CALLED — a precondition, not the effect. `useEffectiveWired` only projects a side once the far
  // end has a selected agent, so `workspace-wired-left` photographed the UNWIRED app for its entire
  // life. Nothing failed if that verification were dropped again, which is the same class of silent
  // mislabelling the commit found (roborev 57327).
  it("emits a data-wired comparison against the requested side", () => {
    const expr = stepToExpression({ cable: "right" });
    expect(expr).toContain("__sparkleCable");
    expect(expr).toMatch(/data-wired[\s\S]*"right"/);
    expect(expr).toContain("workspace-shell");
  });

  it("compares against the side actually requested, for every side", () => {
    expect(stepToExpression({ cable: "left" })).toMatch(/data-wired[\s\S]*"left"/);
    // `off` is a projected value like any other — it must be verified, not exempted.
    expect(stepToExpression({ cable: "off" })).toMatch(/data-wired[\s\S]*"off"/);
  });
});

describe("the mic step's comparison — asserted by EVALUATING it, not by reading its source", () => {
  // WHY THESE EVALUATE. The first version of this block matched the generated SOURCE with
  // `[\s\S]*`-joined regexes, which cannot detect the two mutations that actually break the step:
  // flip `got.status === …` to `!==` and the regex still matches; change the `&&` chain to `||` and
  // all of them still match. In both cases the step would pass precisely when the mic is NOT in the
  // requested state, and every mic surface would go back to photographing whatever it found — with
  // a green suite. These tests guard a COMPARISON, so the thing that must be falsifiable is the
  // comparison's RESULT (roborev 57798). Same rule as "assert the side effect, not the
  // precondition", one level up.

  /** Run a compiled step against a stubbed `window.__sparkleMic` and return what it evaluates to. */
  const runMic = (step, handle) =>
    new Function("window", `return ${stepToExpression(step)}`)({ __sparkleMic: handle });

  const ASKED = { enabled: true, status: "listening", phase: "active" };
  /** A handle that reports exactly the state it was asked for — the passing case. */
  const honest = (s) => ({
    enabled: s.enabled,
    status: s.status ?? "idle",
    phase: s.phase ?? "passive",
    interim: s.interim ?? "",
    voiceSurface: s.voiceSurface ?? "concierge",
  });

  /** What `composer-interim` asks for: a held push-to-talk painting a live preview. */
  const ASKED_INTERIM = {
    enabled: true,
    status: "listening",
    phase: "active",
    voiceSurface: "concierge",
    interim: "these words are still provisional",
  };

  it("passes when the store reports back the state that was requested", () => {
    expect(runMic({ mic: ASKED }, honest)).toBe(true);
  });

  it("FAILS when any single requested field came back different", () => {
    // One case per field, because a comparison chain can be broken one term at a time.
    expect(runMic({ mic: ASKED }, () => ({ ...honest(ASKED), enabled: false }))).toBe(false);
    expect(runMic({ mic: ASKED }, () => ({ ...honest(ASKED), status: "idle" }))).toBe(false);
    expect(runMic({ mic: ASKED }, () => ({ ...honest(ASKED), phase: "passive" }))).toBe(false);
  });

  it("FAILS on a mic left listening by the PREVIOUS surface when this one asked for idle", () => {
    // `{enabled:false}` is the `send-tray-send` form. The harness runs every surface in one browser,
    // so "whatever the last surface left behind" is the realistic wrong answer — an unstated status
    // must be held to the default, not waved through.
    expect(runMic({ mic: { enabled: false } }, () => ({
      enabled: false,
      status: "listening",
      phase: "active",
    }))).toBe(false);
    expect(runMic({ mic: { enabled: false } }, () => ({
      enabled: false,
      status: "idle",
      phase: "active",
    }))).toBe(true);
  });

  it("passes when the store echoes the requested interim and voice surface", () => {
    expect(runMic({ mic: ASKED_INTERIM }, honest)).toBe(true);
  });

  it("FAILS when the interim or the voice surface came back different", () => {
    // THE TWO TERMS THE `composer-interim` SURFACE RESTS ON, and they fail differently.
    //
    // An empty `interim` is the realistic wrong answer: it is the store's own default and what
    // every other surface leaves behind, so a broken term here would let the surface photograph an
    // EMPTY composer under a filename claiming italics — the precise silent-green failure this
    // whole block exists to prevent.
    expect(runMic({ mic: ASKED_INTERIM }, () => ({ ...honest(ASKED_INTERIM), interim: "" })))
      .toBe(false);
    // A different `voiceSurface` is subtler and worse: the concierge only paints while it OWNS
    // dictation, so `"agent"` means the ghost is being drawn in a DIFFERENT box than the one being
    // clipped. The capture would time out rather than lie — but only because this term is checked.
    expect(
      runMic({ mic: ASKED_INTERIM }, () => ({ ...honest(ASKED_INTERIM), voiceSurface: "agent" })),
    ).toBe(false);
  });

  it("leaves an UNSTATED interim or voice surface alone rather than forcing one", () => {
    // Every pre-existing mic surface names neither, so an unstated term must be waved through or
    // `send-tray-*` would start failing on whatever the previous surface left in the store.
    for (const interim of ["", "leftover words"]) {
      for (const voiceSurface of ["concierge", "agent"]) {
        expect(
          runMic({ mic: ASKED }, () => ({ ...honest(ASKED), interim, voiceSurface })),
          `interim=${JSON.stringify(interim)} voiceSurface=${voiceSurface}`,
        ).toBe(true);
      }
    }
  });

  it("leaves an UNSTATED phase alone rather than forcing one", () => {
    // The one genuinely optional term: a caller naming no phase must pass whatever the phase is.
    for (const phase of ["passive", "active"]) {
      expect(runMic({ mic: { enabled: true, status: "listening" } }, () => ({
        enabled: true,
        status: "listening",
        phase,
      }))).toBe(true);
    }
  });

  it("FAILS closed when the handle is missing or returns nothing", () => {
    // Not "the source contains a guard" — the step must EVALUATE to false, so a fixture that never
    // installed the handle fails the run instead of capturing whatever is on screen.
    expect(new Function("window", `return ${stepToExpression({ mic: ASKED })}`)({})).toBe(false);
    expect(runMic({ mic: ASKED }, () => undefined)).toBe(false);
  });
});

describe("a mic surface must END ON A RENDERED READ, not on the step's own write", () => {
  // THE INVARIANT, as a registry rule rather than as three hand-written surfaces that happen to
  // follow it. `__sparkleMic` reads the store back inside its own `setState`, so the step observes
  // only its own write — before React commits and before the app's derivation, which rewrites the
  // same fields. Waiting on `data-mic-presentation` is what makes the capture prove the app actually
  // reached the state its filename claims.
  //
  // Without this case a FOURTH mic surface could be added with the seed and no read, silently
  // reverting to the behaviour the read was introduced to end — the same way `send-tray-send` was
  // right only by accident before the tray got its `data-mode` check (roborev 57803).
  const micSurfaces = SURFACES.filter((s) => (s.app?.steps ?? []).some((st) => st.mic));

  it("covers the mic surfaces that exist (so this rule cannot pass by matching nothing)", () => {
    expect(micSurfaces.length).toBeGreaterThan(0);
  });

  // Keyed on the LAST mic step and on the FINAL step, not on the first seed and "some later read".
  // The looser version did not enforce its own title: `findIndex` takes the earliest seed and any
  // read after it satisfied the scan, so the natural shape for a transition capture —
  // seed, read, SEED AGAIN, shoot — passed while the state the screenshot actually claims went back
  // to being verified by the mic step's own inside-`setState` read-back. That is precisely the
  // failure the rendered read was introduced to end, reported green by the rule meant to make it
  // unrepeatable. The same slack let a `click` follow the read, so the capture no longer ended on it
  // either (roborev 57805).
  // THE READ MUST NAME A PRESENTATION, not merely mention the attribute. `data-mic-presentation` is
  // rendered UNCONDITIONALLY on the waveform div — only its value varies — and a `waitFor` compiles
  // to a bare `querySelector`, so `[data-mic-presentation]` resolves on the first poll whatever the
  // app derived. A substring predicate accepted that, which put the fourth surface right back to
  // being verified by the mic step's own inside-`setState` read-back: the same vacuity this rule
  // exists to prevent, one level down (roborev 57808).
  //
  // A MISMATCHED value is safe by contrast — it times out at capture — so the missing-value case is
  // the only one worth gating here. The name is checked against the union too, so a typo fails at
  // the registry instead of surfacing as a 30s timeout weeks later.
  // ALL THREE ATTRIBUTE-SELECTOR FORMS, because this registry genuinely uses more than one:
  // `[data-mode=speak]` bare, `[aria-label="Settings"]` quoted. A predicate accepting only the bare
  // form fails CLOSED on a correct quoted read — not a vacuity, but the message would tell the
  // author their surface "never reads a NAMED presentation back" while the working read is right
  // there as the final step, and the first person it fires on is the one adding the fourth surface,
  // i.e. the one with the least context to guess that quoting is the cause (roborev 57809).
  const READ = /\[data-mic-presentation\s*=\s*(?:"([A-Za-z]+)"|'([A-Za-z]+)'|([A-Za-z]+))\s*\]/;
  const presentationRead = (sel) => {
    const m = READ.exec(sel);
    return m === null ? null : (m[1] ?? m[2] ?? m[3]);
  };
  const PRESENTATIONS = [
    "off",
    "outOfCredits",
    "error",
    "preparing",
    "focusPaused",
    "activeListening",
    "passiveWaiting",
  ];
  const readsAPresentation = (st) => {
    if (typeof st.waitFor !== "string") return false;
    const name = presentationRead(st.waitFor);
    return name !== null && PRESENTATIONS.includes(name);
  };

  it("accepts every legitimate spelling of the read, and only rejects the value-less one", () => {
    // Bare, double-quoted and single-quoted are all valid CSS and all resolve identically through
    // `document.querySelector` — only a read that names NO value proves nothing.
    for (const sel of [
      "[data-mic-presentation=activeListening]",
      '[data-mic-presentation="activeListening"]',
      "[data-mic-presentation='activeListening']",
      "[data-mic-presentation = activeListening]",
    ]) {
      expect(readsAPresentation({ waitFor: sel }), sel).toBe(true);
    }
    expect(readsAPresentation({ waitFor: "[data-mic-presentation]" })).toBe(false);
    // …and a value that is not a real MicPresentation, which would otherwise only surface as a
    // capture timeout.
    expect(readsAPresentation({ waitFor: "[data-mic-presentation=passiveWating]" })).toBe(false);
  });

  it("ENDS on a rendered read that NAMES a presentation — after the LAST mic step", () => {
    for (const surface of micSurfaces) {
      const steps = surface.app.steps;
      const lastSeed = steps.reduce((acc, st, i) => (st.mic ? i : acc), -1);
      expect(
        steps.slice(lastSeed + 1).some(readsAPresentation),
        `${surface.name} seeds the mic and never reads a NAMED presentation back after the LAST seed`,
      ).toBe(true);
      // …and it is the last thing the surface does, so nothing can run after the state was proven.
      expect(
        readsAPresentation(steps[steps.length - 1]),
        `${surface.name} does not END on a rendered read naming a presentation`,
      ).toBe(true);
    }
  });
});

describe("cli argument parsing", () => {
  it("reads --key=value and bare --flags", () => {
    expect(parseArgs(["--out=/tmp/x", "--verbose", "--scale=2"])).toEqual({
      out: "/tmp/x",
      verbose: true,
      scale: "2",
    });
  });

  it("ignores positionals", () => {
    expect(parseArgs(["ignored", "--a=1"])).toEqual({ a: "1" });
  });

  it("rejects a bare or non-numeric --scale rather than silently picking a density", () => {
    // `Number(args.scale || 2)` turned a bare `--scale` into 1 and `--scale=x` into NaN, both
    // without complaint — a wrong density that reads as a catastrophic design divergence.
    expect(numericArg(undefined, 2, "scale")).toBe(2);
    expect(numericArg("3", 2, "scale")).toBe(3);
    expect(() => numericArg(true, 2, "scale")).toThrow(/--scale must be a number/);
    expect(() => numericArg("x", 2, "scale")).toThrow(/--scale must be a number/);
    expect(() => numericArg("0", 2, "scale")).toThrow(/--scale must be a number/);
    expect(() => numericArg("-1", 2, "scale")).toThrow(/--scale must be a number/);
  });

  it("allows a zero threshold, which is the exact-match default", () => {
    expect(numericArg("0", 0, "threshold", 0)).toBe(0);
    expect(() => numericArg("-1", 0, "threshold", 0)).toThrow(/--threshold/);
  });
});

describe("viewport agreement between capture and compare", () => {
  it("adopts the viewport the capture actually used", () => {
    // The two commands used to parse their own defaults independently, so capturing at --scale=1
    // and comparing at the default 2 scored every surface at half density against a double-density
    // reference — sizes off by exactly 2×, percentage saturated, nothing pointing at the cause.
    const dir = mkdtempSync(join(tmpdir(), "visual-manifest-"));
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }),
    );
    expect(viewportFromManifest(dir)).toEqual({
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      source: "manifest",
    });
  });

  it("lets an explicit CLI flag override the manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "visual-manifest-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ viewport: { deviceScaleFactor: 1 } }));
    expect(viewportFromManifest(dir, { deviceScaleFactor: 3 }).deviceScaleFactor).toBe(3);
  });

  it("falls back to defaults when there is no manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "visual-nomanifest-"));
    expect(viewportFromManifest(dir).source).toBe("default");
    expect(viewportFromManifest(dir).deviceScaleFactor).toBe(2);
  });

  it("survives a corrupt manifest instead of aborting the comparison", () => {
    const dir = mkdtempSync(join(tmpdir(), "visual-badmanifest-"));
    writeFileSync(join(dir, "manifest.json"), "{ not json");
    expect(viewportFromManifest(dir).deviceScaleFactor).toBe(2);
  });
});

describe("determinism check", () => {
  const dirs = () => [
    mkdtempSync(join(tmpdir(), "vs-a-")),
    mkdtempSync(join(tmpdir(), "vs-b-")),
  ];

  it("calls two runs stable only when every artifact matches byte-for-byte", () => {
    const [a, b] = dirs();
    writeFileSync(join(a, "x.png"), Buffer.from([1, 2, 3]));
    writeFileSync(join(b, "x.png"), Buffer.from([1, 2, 3]));
    const r = compareDirs(a, b);
    expect(r.stable).toBe(true);
    expect(r.compared).toBe(1);
    expect(r.identical).toBe(1);
  });

  it("names the artifacts whose bytes differ", () => {
    const [a, b] = dirs();
    writeFileSync(join(a, "x.png"), Buffer.from([1, 2, 3]));
    writeFileSync(join(b, "x.png"), Buffer.from([1, 2, 4]));
    const r = compareDirs(a, b);
    expect(r.stable).toBe(false);
    expect(r.differing).toEqual(["x.png"]);
  });

  it("distinguishes a missing artifact from a differing one", () => {
    const [a, b] = dirs();
    writeFileSync(join(a, "x.png"), Buffer.from([1]));
    writeFileSync(join(a, "only-a.png"), Buffer.from([1]));
    writeFileSync(join(b, "x.png"), Buffer.from([1]));
    const r = compareDirs(a, b);
    expect(r.stable).toBe(false);
    expect(r.onlyA).toEqual(["only-a.png"]);
    expect(r.differing).toEqual([]);
  });

  it("refuses to call two empty directories stable", () => {
    // Otherwise a run that captured nothing at all would report determinism.
    const [a, b] = dirs();
    expect(compareDirs(a, b).stable).toBe(false);
  });

  it("ignores non-artifact files like manifest.json", () => {
    const [a, b] = dirs();
    writeFileSync(join(a, "x.png"), Buffer.from([1]));
    writeFileSync(join(b, "x.png"), Buffer.from([1]));
    writeFileSync(join(a, "manifest.json"), "{}");
    writeFileSync(join(b, "manifest.json"), "{different}");
    expect(compareDirs(a, b).stable).toBe(true);
  });
});

describe("mock resolution", () => {
  it("hides the mock page's own scaffolding, not its design", () => {
    const css = mockChromeCss(["#bar", ".cap"]);
    expect(css).toContain("#bar");
    expect(css).toContain("display: none");
  });

  it("reads an explicit --mock path verbatim", () => {
    const dir = mkdtempSync(join(tmpdir(), "visual-mock-"));
    const p = join(dir, "rev4-standalone.html");
    writeFileSync(p, '<div class="shell" data-wired="off"></div>');
    const { html, source } = resolveMock(p);
    expect(source).toBe(p);
    expect(html).toContain('class="shell"');
  });

  it("reports a clear error when no ref carries the mock", () => {
    // `repoRoot` is overridden to an EMPTY temp dir, not left at the real one. `refs` alone does
    // not skip the working-tree lookup — it is only consulted after `existsSync(repoRoot/MOCK_REL)`
    // fails. Against the real root this passed only because the mock has not landed yet, so it was
    // guaranteed to start failing the day it does: a planned, non-defect change turning CI red with
    // no signal in it. (roborev 54744)
    const emptyRoot = mkdtempSync(join(tmpdir(), "visual-empty-root-"));
    expect(() =>
      // `mockRef: undefined` explicitly, so an ambient SPARKLE_VISUAL_MOCK_REF in the developer's
      // shell cannot change which error this test observes.
      resolveMock(undefined, {
        repoRoot: emptyRoot,
        refs: ["definitely-not-a-ref"],
        mockRef: undefined,
      }),
    ).toThrow(/Could not find .*rev4-standalone\.html/);
  });

  // HARD ASSERTION. This was deliberately soft — a try/catch that warned and returned — on the
  // stated premise that "rev4-standalone.html has not landed on main". It has: the mock landed with
  // the cockpit port, so it is in the working tree on every branch cut from main and the skip can
  // now only ever hide a real breakage in the tree lookup. The soft form outliving its premise is
  // the same shape as the assertion above, which passed only because the mock was absent.
  it("locates the approved mock", () => {
    const found = resolveMock(undefined, { mockRef: undefined });
    expect(found.html).toContain('class="shell"');
    expect(found.html).toContain("data-wired");
  });

  it("rejects an explicit --mock path that does not exist", () => {
    expect(() => resolveMock("/tmp/nope-does-not-exist.html")).toThrow(/does not exist/);
  });

  // SUCCESS-PATH coverage for the `git show <ref>:<path>` fallback. The only other fallback test
  // drives it to failure against a bogus ref, which cannot catch the way this actually breaks: the
  // `ref:path` argument is quoting-sensitive through execFileSync, and a break is silent everywhere
  // except a checkout without the mock in its tree — precisely when the fallback is the only thing
  // standing. Built as a real repo (committed, then removed from the working tree) so step 2 misses
  // and step 3 is forced. (roborev 55085)
  it("falls back to `git show <ref>:<path>` when the working tree lacks the mock", () => {
    const repo = mkdtempSync(join(tmpdir(), "visual-mock-repo-"));
    const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    // Never let a test repo pick up a global core.hooksPath — that is how temp repos have flooded
    // the review DB before.
    git("config", "core.hooksPath", "/dev/null");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    mkdirSync(dirname(join(repo, MOCK_REL)), { recursive: true });
    writeFileSync(join(repo, MOCK_REL), '<div class="shell" data-wired="off"></div>');
    git("add", "-A");
    git("commit", "-qm", "mock");
    // Remove it from the WORKING TREE only; the commit still carries it.
    rmSync(join(repo, MOCK_REL));

    const { html, source } = resolveMock(undefined, {
      repoRoot: repo,
      refs: ["main"],
      mockRef: undefined,
    });
    expect(source).toBe(`git:main:${MOCK_REL}`);
    expect(html).toContain('class="shell"');
  });

  // SPARKLE_VISUAL_MOCK_REF OUTRANKS THE TREE. It used to sit in the candidate list, consulted only
  // after the tree lookup failed — so once the mock landed on main the variable became unreachable
  // on a normal checkout: no effect, no diagnostic, and the run silently scored against the tree
  // copy instead of the named revision. (roborev 55137)
  describe("an explicitly named ref", () => {
    /** A repo whose COMMITTED mock differs from the one in its working tree, so precedence shows. */
    const repoWithBoth = () => {
      const repo = mkdtempSync(join(tmpdir(), "visual-mock-ref-"));
      const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
      git("init", "-q", "-b", "main");
      git("config", "core.hooksPath", "/dev/null");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      mkdirSync(dirname(join(repo, MOCK_REL)), { recursive: true });
      writeFileSync(join(repo, MOCK_REL), '<div class="shell" data-from="the-ref"></div>');
      git("add", "-A");
      git("commit", "-qm", "mock");
      // The working tree now says something DIFFERENT from the commit.
      writeFileSync(join(repo, MOCK_REL), '<div class="shell" data-from="the-tree"></div>');
      return repo;
    };

    it("wins over the working tree", () => {
      const { html, source } = resolveMock(undefined, {
        repoRoot: repoWithBoth(),
        mockRef: "main",
      });
      expect(source).toBe(`git:main:${MOCK_REL}`);
      expect(html).toContain("the-ref");
      expect(html).not.toContain("the-tree");
    });

    it("fails loudly rather than silently scoring against the tree", () => {
      // The whole point: a typo'd ref must NOT quietly resolve to the tree copy, because the report
      // would then be a confident number against a revision nobody asked for.
      expect(() =>
        resolveMock(undefined, { repoRoot: repoWithBoth(), mockRef: "no-such-ref" }),
      ).toThrow(/SPARKLE_VISUAL_MOCK_REF=no-such-ref does not carry/);
    });

    // THE PRODUCTION WIRING, not just the branch. Every other test here passes `mockRef` as an
    // option — deliberately, so an ambient value cannot perturb them — which leaves the
    // `= process.env.SPARKLE_VISUAL_MOCK_REF` default parameter as the one line that makes the
    // feature exist for a real caller (`compare.mjs` calls `resolveMock(args.mock)` with no
    // options) and the one line nothing exercised. Deleting it would revert the variable to having
    // no effect and no diagnostic, with the whole suite still green. (roborev 55140)
    it("reads SPARKLE_VISUAL_MOCK_REF from the environment", () => {
      const prev = process.env.SPARKLE_VISUAL_MOCK_REF;
      process.env.SPARKLE_VISUAL_MOCK_REF = "main";
      try {
        const { source, html } = resolveMock(undefined, { repoRoot: repoWithBoth() });
        expect(source).toBe(`git:main:${MOCK_REL}`);
        expect(html).toContain("the-ref");
      } finally {
        if (prev === undefined) delete process.env.SPARKLE_VISUAL_MOCK_REF;
        else process.env.SPARKLE_VISUAL_MOCK_REF = prev;
      }
    });

    it("still yields to an explicit --mock path", () => {
      const dir = mkdtempSync(join(tmpdir(), "visual-mock-explicit-"));
      const p = join(dir, "rev4-standalone.html");
      writeFileSync(p, '<div class="shell" data-from="the-flag"></div>');
      const { html, source } = resolveMock(p, { repoRoot: repoWithBoth(), mockRef: "main" });
      expect(source).toBe(p);
      expect(html).toContain("the-flag");
    });
  });
});

describe("keep-or-clean rule for the determinism check", () => {
  // The three behaviours the keep/clean rule exists to guarantee. Previously unreachable without
  // provoking a real determinism failure, so a refactor could reintroduce "evidence deleted on
  // failure" — the exact regression this rule was written for — with every test still green.
  it("keeps the captures when the runs disagree", () => {
    expect(shouldKeep({ keepArg: undefined, outcome: "unstable" })).toBe(true);
  });

  it("keeps the captures when a run threw and left partial output", () => {
    expect(shouldKeep({ keepArg: undefined, outcome: "threw", hasOutput: true })).toBe(true);
  });

  it("cleans up after a stable run", () => {
    expect(shouldKeep({ keepArg: undefined, outcome: "stable" })).toBe(false);
  });

  // The missing-Chrome case: run 1 fails outright, so BOTH directories are empty. Announcing
  // "artifacts kept for inspection" above the stack trace points the reader at two empty
  // directories and leaks them permanently.
  it("does not keep two empty directories when run 1 never produced anything", () => {
    expect(shouldKeep({ keepArg: undefined, outcome: "threw", hasOutput: false })).toBe(false);
  });

  it("honours an explicit --keep even with nothing to show", () => {
    expect(shouldKeep({ keepArg: "true", outcome: "stable", hasOutput: false })).toBe(true);
  });

  // `--keep=false` parses to the STRING "false", which is truthy — the bug that made the flag
  // impossible to turn off once given.
  it("treats --keep=false as a request to clean", () => {
    expect(shouldKeep({ keepArg: "false", outcome: "stable" })).toBe(false);
    // …but an explicit --keep=false must NOT override the failure path, which is what the
    // evidence rule is for.
    expect(shouldKeep({ keepArg: "false", outcome: "unstable" })).toBe(true);
  });
});

// ── THE SEAM PROBE ─────────────────────────────────────────────────────────────────────────────
//
// This instrument is the reason the mounted-row seam was finally diagnosed rather than guessed at,
// so its arithmetic has to be trustworthy in its own right: a probe that reports "continuous" for a
// broken join is worse than no probe, because it launders a guess into a measurement. The cases
// below pin the two judgements that actually decided the diagnosis.
describe("seam probe", () => {
  /** One scanline as an image, so scanRow is exercised through real pixel data. */
  const strip = (colors) => {
    const im = { width: colors.length, height: 1, data: Buffer.alloc(colors.length * 4) };
    colors.forEach((c, i) => {
      im.data[i * 4] = c[0];
      im.data[i * 4 + 1] = c[1];
      im.data[i * 4 + 2] = c[2];
      im.data[i * 4 + 3] = 255;
    });
    return im;
  };
  const A = [3, 9, 19];
  const B = [9, 20, 38];

  it("collapses a scanline into runs with absolute positions", () => {
    const runs = scanRow(strip([A, A, B, B, B, A]), 0, 0, 5, 2);
    expect(runs.map((r) => [r.from, r.to, r.hex])).toEqual([
      [0, 1, "#030913"],
      [2, 4, "#091426"],
      [5, 5, "#030913"],
    ]);
  });

  it("anchors tolerance to the run's START, so a gradient cannot be swallowed", () => {
    // Each step is within tolerance of the LAST pixel but not of the first. Chained comparison
    // would report one run and hide a soft shadow edge — which is a real way this seam separates.
    const ramp = [[0, 0, 0], [0, 0, 2], [0, 0, 4], [0, 0, 6], [0, 0, 8]];
    expect(runsOf(ramp.map(([r, g, b]) => ({ r, g, b })), 2).length).toBeGreaterThan(1);
  });

  it("uses MAX per-channel difference, so a one-channel rule still counts", () => {
    expect(channelDelta({ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 40 })).toBe(40);
  });

  // THE JUDGEMENT THAT MATTERED. The real defect was a 14px band — far too wide for any rule-width
  // threshold — sitting between two byte-identical planes. A width-only verdict called that
  // "continuous", which is precisely the false pass this whole exercise exists to stop.
  it("calls a WIDE band a seam when the plane either side is the same", () => {
    const runs = scanRow(strip([...Array(6).fill(A), ...Array(14).fill(B), ...Array(6).fill(A)]), 0, 0, 25, 2);
    const v = verdict(runs, 6, 2);
    expect(v.sameEnds).toBe(true);
    expect(v.continuous).toBe(false);
    expect(v.interlopers).toHaveLength(1);
    expect(v.interlopers[0].width).toBe(14);
  });

  it("does NOT flag a wide band between two genuinely different planes", () => {
    const C = [200, 200, 200];
    const runs = scanRow(strip([...Array(6).fill(A), ...Array(14).fill(B), ...Array(6).fill(C)]), 0, 0, 25, 2);
    expect(verdict(runs, 6, 2).continuous).toBe(true);
  });

  it("still flags a NARROW rule even when the planes either side differ", () => {
    const C = [200, 200, 200];
    const runs = scanRow(strip([...Array(6).fill(A), B, B, ...Array(6).fill(C)]), 0, 0, 13, 2);
    expect(verdict(runs, 6, 2).continuous).toBe(false);
  });

  it("reports a truly continuous join as continuous", () => {
    const v = verdict(scanRow(strip(Array(20).fill(A)), 0, 0, 19, 2), 6, 2);
    expect(v.continuous).toBe(true);
    expect(v.runCount).toBe(1);
    // The ends of a one-run scan are trivially identical; reporting false made the field useless
    // to a JSON consumer trying to tell the two shapes apart.
    expect(v.sameEnds).toBe(true);
  });

  // THE FALSE PASS `strict` EXISTS FOR. Two runs meeting is the right answer for a panel BOUNDARY
  // and the wrong one for a JOINT: if the row's plane drifts off the token while the fill and the
  // concierge keep it, the scan is a hard colour step down the join with no middle run for
  // `sameEnds` to flag, and the default rule passes it (roborev 57327).
  it("passes a two-plane step by default but fails it under --strict", () => {
    const step = scanRow(strip([...Array(10).fill(A), ...Array(10).fill(B)]), 0, 0, 19, 2);
    expect(verdict(step, 6, 2).continuous).toBe(true);
    expect(verdict(step, 6, 2, { strict: true }).continuous).toBe(false);
    expect(verdict(step, 6, 2, { strict: true }).runCount).toBe(2);
    // …and strict still passes the genuinely unbroken join.
    const solid = scanRow(strip(Array(20).fill(A)), 0, 0, 19, 2);
    expect(verdict(solid, 6, 2, { strict: true }).continuous).toBe(true);
  });

  it("parses N and N..M ranges, and rejects an inverted one", () => {
    expect(parseRange("700..760", "x")).toEqual({ from: 700, to: 760 });
    expect(parseRange("42", "y")).toEqual({ from: 42, to: 42 });
    expect(() => parseRange("9..2", "x")).toThrow(/inverted/);
    expect(() => parseRange(undefined, "x")).toThrow(/required/);
  });

  it("refuses a pixel read outside the image rather than returning black", () => {
    // A silent 0 reads as a real colour, which would turn a bad coordinate into a confident wrong
    // answer — the exact failure mode this tool exists to remove.
    expect(() => scanRow(strip([A]), 0, 0, 5, 2)).toThrow(/outside/);
  });

  it("hexes a colour the way the report prints it", () => {
    expect(toHex({ r: 3, g: 9, b: 19 })).toBe("#030913");
  });
});

// ── THE --strict FLAG'S WIRING ────────────────────────────────────────────────────────────────
//
// `verdict`'s strict branch was covered; the wiring that lets `--strict` REACH it was not. `main()`
// is not exported and no test drove the flag, so deleting the resolution would have left every test
// green while `--strict` silently degraded to the permissive panel rule and reported `continuous`
// on the exact two-plane step it was added to catch — the instrument scoring the wrong state with
// nothing failing, which is the shape this whole branch is draining (roborev 57352).
describe("--strict reaches the verdict", () => {
  const strip2 = (colors) => {
    const im = { width: colors.length, height: 1, data: Buffer.alloc(colors.length * 4) };
    colors.forEach((c, i) => {
      im.data[i * 4] = c[0];
      im.data[i * 4 + 1] = c[1];
      im.data[i * 4 + 2] = c[2];
      im.data[i * 4 + 3] = 255;
    });
    return im;
  };

  it("resolves the flag from the CLI, present or absent", () => {
    expect(wantsStrict(probeArgs(["--strict"]))).toBe(true);
    expect(wantsStrict(probeArgs(["--strict=true"]))).toBe(true);
    expect(wantsStrict(probeArgs([]))).toBe(false);
    expect(wantsStrict(probeArgs(["--json"]))).toBe(false);
  });

  // END TO END over the row loop the CLI actually runs: the same two-plane image flips verdict with
  // the flag. This is what fails if `{ strict }` is dropped on the way through.
  it("flips the row loop's verdict on a two-plane step", () => {
    const img = strip2([...Array(10).fill([3, 9, 19]), ...Array(10).fill([9, 20, 38])]);
    const opts = { yFrom: 0, yTo: 0, xFrom: 0, xTo: 19, tolerance: 2 };
    expect(probeRows(img, { ...opts, strict: false })[0].continuous).toBe(true);
    expect(probeRows(img, { ...opts, strict: true })[0].continuous).toBe(false);
    // …and the genuinely unbroken join passes under both.
    const solid = strip2(Array(20).fill([3, 9, 19]));
    expect(probeRows(solid, { ...opts, strict: true })[0].continuous).toBe(true);
  });

  // THE JOIN ITSELF, not just its two ends. Extracting `wantsStrict` alone only moved the untested
  // seam one frame out: the line mapping argv onto `probeRows`' parameters lived in the unexported
  // `main()`, so `strict: false` there left everything green while `--strict` degraded on the real
  // command line — and a transposed `xFrom`/`yFrom` was equally invisible (roborev 57377).
  it("maps the whole argv into probeRows' parameters, strict included", () => {
    expect(probeOptions(probeArgs(["--y=5..7", "--x=1..9", "--strict"]))).toEqual({
      yFrom: 5, yTo: 7, xFrom: 1, xTo: 9, tolerance: 2, strict: true,
    });
    // Axes must not transpose, and the flag must not leak in when absent.
    expect(probeOptions(probeArgs(["--y=100..100", "--x=200..300", "--tolerance=5"]))).toEqual({
      yFrom: 100, yTo: 100, xFrom: 200, xTo: 300, tolerance: 5, strict: false,
    });
  });

  it("does not call an EMPTY scan continuous", () => {
    // `pixelAt` throws rather than returning a confident wrong answer for an out-of-bounds read;
    // a verdict on nothing must not be a confident pass either.
    expect(verdict([], 6, 2, { strict: true }).continuous).toBe(false);
    expect(verdict([], 6, 2).continuous).toBe(false);
  });
});

// ── THE RECAP-NARROW PROBE'S VERDICT RULES ─────────────────────────────────────────────────────
//
// WHY THIS BLOCK EXISTS (roborev 58700). `recap-narrow-probe.mjs` is the only half of the
// narrow-column work that can fail on real geometry, and nothing referenced it: not
// `apps/desktop/package.json`, not `scripts/tests/run.sh`, and not one import of `verdictFor`,
// `parseArgs`, `DEFAULT_WIDTHS`, `MAX_ROW_LINES`, `EDGE_TOLERANCE` or `BASELINE_OFFSET_PX` —
// despite the file's closing comment claiming its pure helpers stay "importable by a unit test".
// Its sibling `seam-probe.mjs` has had exactly that coverage all along, three blocks up.
//
// The rules are fed SYNTHETIC measurements, which is the point: an instrument whose judgements have
// never been shown to fail is an instrument that can report a clean card while the card overflows.
describe("recap-narrow probe — the verdict rules, fed synthetic measurements", () => {
  /** One row as `MEASURE` returns it. Defaults describe a healthy single-line change row. */
  const row = (over = {}) => ({
    testid: "recap-change",
    text: "sparkle@AgentDone",
    height: 18,
    lineHeight: 18,
    lines: 1,
    overhang: -20,
    statusHeight: 18,
    statusLines: 1,
    statusSameLine: true,
    proseHeight: null,
    ...over,
  });

  /** A whole measurement. Defaults are a card that passes everything. */
  const measurement = (over = {}) => ({
    cardScrollWidth: 200,
    cardClientWidth: 200,
    columnWidth: 200,
    offenders: [],
    // TWO ROWS, one of which WRAPPED: a card whose rows all fit trips the probe's own vacuity guard
    // ("the long row genuinely reflowed at this width"), which is correct behaviour and would make
    // every "healthy card" fixture here a failing one.
    rows: [row(), row({ text: "sparkle@Long AgentDone — your turn", lines: 2.2, statusSameLine: false })],
    names: [{ text: "@Agent", scrollWidth: 90, clientWidth: 40, truncated: true }],
    baseline: { refBottom: 100, pillBottom: 102, delta: 2 },
    dotless: [
      { form: "unwired", testid: "concierge-agent-pill-unwired", hasDot: false, nameOverflow: "clip", refBottom: 100, pillBottom: 100, delta: 0 },
    ],
    ...over,
  });

  const CLICKED = { tag: "BUTTON", clicks: ["a"], title: "Open Concierge Says What It Is Doing in sparkle" };

  /** Did the named check pass? `undefined` when the rule did not run at this width at all, which is
   *  a different thing from failing and must not be readable as a pass. */
  const check = (v, fragment) => v.checks.find((c) => c.name.includes(fragment))?.ok;
  const failed = (v) => v.checks.filter((c) => !c.ok).map((c) => c.name);

  it("passes a healthy card", () => {
    expect(failed(recapVerdict(280, measurement(), CLICKED))).toEqual([]);
  });

  // ── THE EMPTY-ROWS GUARD ────────────────────────────────────────────────────────────────────
  // Every fold used to seed from `m.rows[0]`. With no rows that seed is `undefined`, the fold throws
  // a TypeError, and `main().catch` exits 2 — which the probe's own header defines as "could not
  // run (no Chrome, no server)". So a RENAMED TESTID reported itself as an environment problem, and
  // the reader wires up Chrome instead of looking at the regression.
  it("reports an empty row set as a FAILED CHECK, not by throwing", () => {
    let v;
    expect(() => {
      v = recapVerdict(280, measurement({ rows: [] }), CLICKED);
    }).not.toThrow();
    expect(check(v, "rendered rows to measure")).toBe(false);
    // …and it stops there rather than half-judging a card it could not see.
    expect(check(v, "no row's content passes")).toBeUndefined();
  });

  it("reports change rows going missing separately from rows going missing", () => {
    // A card with only decision rows: `rows` is non-empty, so the guard above says nothing, but
    // every hybrid rule below judges CHANGE rows and would fold over an empty list.
    const onlyDecisions = measurement({
      rows: [row({ testid: "recap-decision", proseHeight: 18 })],
    });
    let v;
    expect(() => {
      v = recapVerdict(280, onlyDecisions, CLICKED);
    }).not.toThrow();
    expect(check(v, "rendered CHANGE rows")).toBe(false);
  });

  // The same guard BELOW the hybrid floor, which is where it used to be skipped entirely
  // (roborev 58761): it was gated behind `width >= HYBRID_MIN_WIDTH` with an empty else-branch, so
  // `--widths=100` on a card whose change rows had vanished produced zero checks and reported PASS.
  // The below-floor branch asserts "clipped, never word-stacked", so it needs change rows too.
  it("reports change rows going missing BELOW the hybrid floor, where the rule still bites", () => {
    const onlyDecisions = measurement({
      rows: [row({ testid: "recap-decision", proseHeight: 18 })],
    });
    expect(check(recapVerdict(100, onlyDecisions, CLICKED), "rendered CHANGE rows")).toBe(false);
    // …and the width is genuinely below the floor, so this is not the >=200 path in disguise.
    expect(100).toBeLessThan(HYBRID_MIN_WIDTH);
  });

  // A stale showClosed selector must GRADE, not crash the run into exit 2 — see the arming step in
  // `main()`. `verdictFor` only speaks about it when the probe actually reported an arming outcome.
  it("fails when the showClosed control could not be armed", () => {
    const notArmed = measurement({
      armed: { armed: false, reason: "no live pill in #prose-showclosed" },
    });
    expect(check(recapVerdict(280, notArmed, CLICKED), "showClosed control was reachable")).toBe(
      false,
    );
    const armed = measurement({ armed: { armed: true } });
    expect(check(recapVerdict(280, armed, CLICKED), "showClosed control was reachable")).toBe(true);
    // Absent entirely (an older measurement) says nothing rather than failing.
    expect(
      check(recapVerdict(280, measurement(), CLICKED), "showClosed control was reachable"),
    ).toBeUndefined();
  });

  // A renamed `#prose-ref` / prose pill used to reach `.toFixed` on a null and throw, which
  // main().catch turns into exit 2 — "the probe could not run" — hiding the rename that caused it
  // (roborev 58797). MEASURE now returns null fields and verdictFor grades them.
  it("fails, rather than throwing, when the baseline reference is missing", () => {
    const noRef = measurement({
      baseline: { refBottom: null, pillBottom: null, delta: null, missing: "#prose-ref" },
    });
    let v;
    expect(() => {
      v = recapVerdict(280, noRef, CLICKED);
    }).not.toThrow();
    expect(check(v, "has not MOVED on its sentence's baseline")).toBe(false);
    // …and it names what it could not find, so the reader fixes the selector rather than Chrome.
    const detail = v.checks.find((c) => c.name.includes("has not MOVED")).detail;
    expect(detail).toContain("#prose-ref");
  });

  // ── THE CLI CONTRACT, which used to pin a property the code did not have ─────────────────────
  // `--widths` bare arrives as boolean `true`; the old `String(true).split(",").map(Number)` gave
  // `[NaN]`, the probe navigated to `?w=NaN`, the column fell back to the 1200px viewport, and every
  // width comparison in `verdictFor` was false for NaN — so the narrow rules were graded against a
  // wide layout and reported PASS. `parseWidths` returns null for anything that is not a width list.
  it("refuses a --widths value that is not a list of positive numbers", () => {
    expect(recapWidths(undefined)).toEqual(DEFAULT_WIDTHS);
    expect(recapWidths("520,360,280")).toEqual([520, 360, 280]);
    expect(recapWidths(" 280 , 200 ")).toEqual([280, 200]);
    expect(recapWidths(true)).toBeNull(); // `--widths` with no value
    expect(recapWidths("520,,200")).toBeNull(); // an empty slot coerces to 0
    expect(recapWidths("wide")).toBeNull(); // a typo
    expect(recapWidths("-280")).toBeNull(); // negative
    expect(recapWidths("0")).toBeNull(); // zero
    expect(recapWidths("")).toBeNull();
  });

  // ── CONTAINMENT ─────────────────────────────────────────────────────────────────────────────
  it("fails a row whose content passes the card's content edge", () => {
    const v = recapVerdict(280, measurement({ rows: [row({ overhang: 22 })] }), CLICKED);
    expect(check(v, "passes the card's content edge")).toBe(false);
  });

  it("allows sub-pixel slack, so rounding is not reported as an overflow", () => {
    const v = recapVerdict(280, measurement({ rows: [row({ overhang: EDGE_TOLERANCE })] }), CLICKED);
    expect(check(v, "passes the card's content edge")).toBe(true);
  });

  it("fails a card that scrolls horizontally, and names what went past the edge", () => {
    const v = recapVerdict(
      280,
      measurement({
        cardScrollWidth: 240,
        offenders: [{ testid: "concierge-agent-pill-name", tag: "SPAN", text: "@Agent", past: 22 }],
      }),
      CLICKED,
    );
    const c = v.checks.find((x) => x.name.includes("does not scroll"));
    expect(c.ok).toBe(false);
    // The detail is the whole reason the offender list is collected: "scrollWidth 240 <= 200" on its
    // own says the card overflows and nothing about WHAT, and the row-level check next door is blind
    // to the summary line and the section headings.
    expect(c.detail).toContain("concierge-agent-pill-name");
    expect(c.detail).toContain("+22.0px");
  });

  // ── THE FOUNDER'S HYBRID ────────────────────────────────────────────────────────────────────
  it("fails a word-stacked status — the exact failure the reflow was written to kill", () => {
    const stacked = measurement({ rows: [row({ lines: 3, statusLines: 3, statusSameLine: false })] });
    expect(check(recapVerdict(280, stacked, CLICKED), "stays on ONE line")).toBe(false);
  });

  it("fails a row that wrapped in the WRONG place — the pill squeezed instead of the status moved", () => {
    // `statusSameLine: true` on a row taller than one line means the break fell inside the lead
    // group, which is the always-one-line-truncate layout the founder rejected.
    const wrongBreak = measurement({ rows: [row({ lines: 2.2, statusSameLine: true })] });
    const v = recapVerdict(280, wrongBreak, CLICKED);
    expect(check(v, "moved its STATUS to its own line")).toBe(false);
  });

  it("fails a row that grew past the line budget", () => {
    const tall = measurement({ rows: [row({ lines: MAX_ROW_LINES + 0.1, statusSameLine: false })] });
    expect(check(recapVerdict(280, tall, CLICKED), "exceeds")).toBe(false);
  });

  it("refuses to judge the wrap rule vacuously — no wrapped row is itself a failure", () => {
    // With every row on one line there is nothing for "wrapped in the right place" to judge, so it
    // would pass by having no evidence. The fixture must actually REACH the state under test.
    const v = recapVerdict(280, measurement({ rows: [row()] }), CLICKED);
    expect(check(v, "genuinely reflowed")).toBe(false);
    expect(check(v, "moved its STATUS to its own line")).toBe(true); // …passing vacuously, hence the guard
  });

  it("fails an orphaned decision verb — the sentence pushed off the verb's line", () => {
    // A row exactly one line-height taller than its own prose is the shape a max-content flex basis
    // produces on `decisionProse`.
    const orphan = measurement({
      rows: [
        row({ lines: 2.2, statusSameLine: false }),
        row({ testid: "recap-decision", height: 36, proseHeight: 18, lines: 2 }),
      ],
    });
    expect(check(recapVerdict(280, orphan, CLICKED), "shares its line")).toBe(false);
  });

  it("holds the WIDE end to one line, which is the 'unchanged when there is room' half", () => {
    const wrapped = measurement({ rows: [row({ lines: 2.2, statusSameLine: false })] });
    const v = recapVerdict(520, wrapped, CLICKED);
    expect(check(v, "still ONE line when there is room")).toBe(false);
    expect(check(v, "share ONE line when there is room")).toBe(false);
  });

  // ── THE FLOOR, AS A RULE RATHER THAN A COMMENT ──────────────────────────────────────────────
  it("gives up the LINE BUDGET below the hybrid floor but never containment", () => {
    // Three lines at 100px is in contract (the chip alone fills the line, so the group breaks); the
    // same row at 280px is not. Asserting both directions is what makes the floor a decision rather
    // than a gap — and containment must still be judged at the narrow end.
    const tall = measurement({ rows: [row({ lines: 3.6, statusSameLine: false, overhang: -5 })] });
    expect(check(recapVerdict(100, tall, CLICKED), "exceeds")).toBeUndefined();
    expect(check(recapVerdict(280, tall, CLICKED), "exceeds")).toBe(false);
    expect(check(recapVerdict(100, tall, CLICKED), "passes the card's content edge")).toBe(true);
    const spilling = measurement({ rows: [row({ lines: 3.6, statusSameLine: false, overhang: 22 })] });
    expect(check(recapVerdict(100, spilling, CLICKED), "passes the card's content edge")).toBe(false);
  });

  it("still forbids a word-stacked status below the floor — clipped, never stacked", () => {
    const stacked = measurement({ rows: [row({ lines: 3.6, statusLines: 2, statusSameLine: false })] });
    expect(check(recapVerdict(100, stacked, CLICKED), "clipped, never word-stacked")).toBe(false);
  });

  it("sweeps every width down to the resize engine's floor", () => {
    // The band this whole exercise is about is 50-135px, and the list stopping at 200 is what let a
    // regression ship there. Sourced from the app's own constant rather than re-spelled.
    expect(Math.min(...DEFAULT_WIDTHS)).toBe(CONCIERGE_MIN_WIDTH);
    expect(DEFAULT_WIDTHS).toContain(CONCIERGE_DEFAULT_WIDTH);
    expect(DEFAULT_WIDTHS.some((w) => w < HYBRID_MIN_WIDTH)).toBe(true);
  });

  // ── THE DOT-LESS BASELINE CONTROLS ──────────────────────────────────────────────────────────
  it("fails a name span that clips by becoming a SCROLL CONTAINER", () => {
    const hidden = measurement({
      dotless: [{ form: "unwired", testid: "x", hasDot: false, nameOverflow: "hidden", refBottom: 100, pillBottom: 100, delta: 0 }],
    });
    expect(check(recapVerdict(280, hidden, CLICKED), "WITHOUT becoming a scroll container")).toBe(false);
  });

  it("fails a dot-less pill that has drifted off its sentence's baseline", () => {
    const drifted = measurement({
      dotless: [{ form: "unwired", testid: "x", hasDot: false, nameOverflow: "clip", refBottom: 100, pillBottom: 117, delta: 17 }],
    });
    expect(check(recapVerdict(280, drifted, CLICKED), "sits ON its sentence's baseline")).toBe(false);
  });

  it("fails a 'dot-less' control that has quietly grown a dot", () => {
    // The vacuity guard. An unwired pill draws a dot the moment its id resolves, at which point the
    // control is a second copy of the SHIELDED case and proves nothing about the hazard.
    const dotted = measurement({
      dotless: [{ form: "unwired", testid: "x", hasDot: true, nameOverflow: "clip", refBottom: 100, pillBottom: 100, delta: 0 }],
    });
    expect(check(recapVerdict(280, dotted, CLICKED), "really is dot-less")).toBe(false);
  });

  it("fails when the dot-less controls are missing from the page entirely", () => {
    expect(check(recapVerdict(280, measurement({ dotless: [] }), CLICKED), "on the page at all")).toBe(false);
  });

  it("keeps the dotted pill's PRE-EXISTING 2px offset passing — 'has not moved', not 'is zero'", () => {
    // That offset predates this branch (the pill's baseline is donated by its empty 6px dot).
    // Asserting zero would fail on untouched code and tempt someone to "fix" it by moving every pill
    // in every concierge reply.
    expect(check(recapVerdict(280, measurement(), CLICKED), "has not MOVED")).toBe(true);
    const moved = measurement({ baseline: { refBottom: 100, pillBottom: 118, delta: 18 } });
    expect(check(recapVerdict(280, moved, CLICKED), "has not MOVED")).toBe(false);
  });

  // ── THE VERY-NARROW CLAIMS ──────────────────────────────────────────────────────────────────
  it("fails when nothing was actually truncated at the truncation width", () => {
    const untruncated = measurement({
      names: [{ text: "@Agent", scrollWidth: 40, clientWidth: 40, truncated: false }],
    });
    expect(check(recapVerdict(200, untruncated, CLICKED), "genuinely truncated")).toBe(false);
  });

  it("fails a truncated pill that stopped being a working control", () => {
    expect(check(recapVerdict(200, measurement(), { ...CLICKED, clicks: [] }), "working control")).toBe(false);
    expect(check(recapVerdict(200, measurement(), { ...CLICKED, tag: "SPAN" }), "working control")).toBe(false);
  });

  it("fails when the full name did not survive in the tooltip", () => {
    const v = recapVerdict(200, measurement(), { ...CLICKED, title: "Open Concierge Say… in sparkle" });
    expect(check(v, "survives truncation in the tooltip")).toBe(false);
  });

  it("does not make the truncation claims at a width where nothing should be truncated", () => {
    // The rules are width-scoped; a rule that did not run must read as absent, not as a pass.
    const v = recapVerdict(520, measurement(), CLICKED);
    expect(check(v, "genuinely truncated")).toBeUndefined();
  });
});

describe("recap-narrow probe — the CLI contract", () => {
  it("reads --widths and --json the way the probe's own docs promise", () => {
    expect(recapArgs(["--widths=520,280,200", "--json"])).toEqual({
      widths: "520,280,200",
      json: true,
    });
    expect(recapArgs([])).toEqual({});
    // A bare `--widths` yields `true`, which `main()` must not treat as a width list — the guard
    // there is `args.widths ? … : DEFAULT_WIDTHS`, so this documents the shape it receives.
    expect(recapArgs(["--widths"])).toEqual({ widths: true });
  });
});

describe("crop", () => {
  it("cuts the requested region and magnifies by pixel replication", () => {
    const im = { width: 4, height: 1, data: Buffer.alloc(16) };
    [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]].forEach((c, i) => {
      im.data[i * 4] = c[0];
      im.data[i * 4 + 1] = c[1];
      im.data[i * 4 + 2] = c[2];
      im.data[i * 4 + 3] = 255;
    });
    const out = crop(im, { x0: 1, x1: 2, y0: 0, y1: 0, zoom: 3 });
    expect([out.width, out.height]).toEqual([6, 3]);
    // Nearest-neighbour: every replicated pixel is the SOURCE colour, never an interpolation —
    // a smoothed zoom invents intermediate colours, which is what makes a 1px rule arguable.
    expect([out.data[0], out.data[1], out.data[2]]).toEqual([4, 5, 6]);
    expect([out.data[12], out.data[13], out.data[14]]).toEqual([7, 8, 9]);
  });

  it("refuses a region that falls outside the image", () => {
    expect(() => crop(blank(4, 4), { x0: 0, x1: 9, y0: 0, y1: 1 })).toThrow(/outside/);
  });
});

// ── THE HARNESS ACTUALLY SENDS THE MARKER THE FIXTURE REACTS TO (roborev 57726) ───────────────
//
// The cross-surface reset in `visualFixtures` is gated on `capture=1`. Every test over there hand-
// builds "?visual=1&capture=1", so they prove the REACTION and not the SENDING — drop the marker
// from the driver and the reset silently goes dead while captures keep succeeding and the suite
// keeps passing. These assertions cross the boundary: the driver's URL is fed to the APP'S OWN
// predicate, so the two spellings cannot drift apart.
describe("surfaceUrl — the driver's contract with the fixture", () => {
  it("marks every registry surface as a capture run, per the app's own predicate", () => {
    for (const s of SURFACES) {
      const search = new URL(surfaceUrl("http://localhost:1234", s)).search;
      expect(visualCaptureRun(search), `${s.name} must be marked as a capture run`).toBe(true);
      expect(visualFixturesRequested(search), `${s.name} must turn fixtures on`).toBe(true);
    }
  });

  it("carries the surface's OWN query through untouched", () => {
    const url = new URL(surfaceUrl("http://localhost:1234", { query: "prs=1&concierge=190" }));
    expect(url.searchParams.get("prs")).toBe("1");
    expect(url.searchParams.get("concierge")).toBe("190");
    expect(visualCaptureRun(url.search)).toBe(true);
  });

  it("is well-formed for a surface with no query of its own", () => {
    const url = new URL(surfaceUrl("http://localhost:1234", {}));
    expect(url.pathname).toBe("/");
    expect(visualCaptureRun(url.search)).toBe(true);
  });
});

// ── EVERY DOCUMENT STARTS FROM A COLD ORIGIN ──────────────────────────────────────────────────
//
// A fresh page is not a fresh store: the run shares one browser and one profile, and `localStorage`
// is origin-scoped, so a key a surface never writes holds whatever the surface before it left. That
// shipped once already — a "wide" capture inherited the previous narrow column and the pair came
// out byte-identical with the suite green.
//
// No unit test can watch two real page loads, so these run the REAL init sources against a storage
// stub instead. That is the only place the property is observable at this level: the sources are
// strings, so a mistake in them is invisible to the module graph, to typechecking, and to every
// screenshot the harness produces.
//
// ONE FIXTURE PER PROPERTY, deliberately. Removing the clear and re-ordering it after the shims are
// different defects, and a single combined test would have passed under either mutation alone.
describe("the capture driver's init scripts", () => {
  // Enough of a browser for the three real sources to run: they touch `window`, build a <style>,
  // and reach for the two storages. Anything they do not use is left out on purpose — a stub that
  // answers more than the code asks for hides the day the code starts asking for something else.
  const runInitScripts = (sources, { storageThrows = false } = {}) => {
    const makeStorage = (seed = {}) => {
      const map = new Map(Object.entries(seed));
      return {
        clear: () => map.clear(),
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        get size() {
          return map.size;
        },
      };
    };
    const local = makeStorage({ "sparkle-concierge-width": "190", "some-future-key": "stale" });
    const session = makeStorage({ "scroll-pos": "400" });
    const ctx = {
      window: {},
      document: {
        documentElement: { appendChild: () => {} },
        createElement: () => ({ textContent: "" }),
        addEventListener: () => {},
      },
    };
    // A storage that THROWS on access is a real browser state (storage disabled for the origin),
    // and these scripts run before the app — an escaping throw would blank every surface.
    if (storageThrows) {
      const boom = () => {
        throw new Error("storage is disabled for this origin");
      };
      Object.defineProperty(ctx, "localStorage", { get: boom });
      Object.defineProperty(ctx, "sessionStorage", { get: boom });
    } else {
      ctx.localStorage = local;
      ctx.sessionStorage = session;
    }
    createContext(ctx);
    for (const source of sources) new Script(source).runInContext(ctx);
    return { local, session };
  };

  it("leaves the previous surface's localStorage EMPTY before any app code runs", () => {
    const { local, session } = runInitScripts(INIT_SCRIPTS);
    expect(local.size, "a key from the previous surface survived into this document").toBe(0);
    expect(session.size, "sessionStorage bleeds across surfaces the same way").toBe(0);
  });

  // THE CLEAR MUST BE FIRST, not merely present. Ordered after a shim that seeds storage it would
  // erase that shim's writes — the opposite failure, and just as invisible. Standing in for such a
  // shim here rather than asserting `INIT_SCRIPTS[0] === CLEAR_STORAGE` keeps this a statement about
  // what the sequence DOES: move the clear to the end and the seeded value is gone.
  it("clears BEFORE the other init scripts, so their own writes survive", () => {
    const seeder = `localStorage.setItem("seeded-by-a-later-init-script", "kept");`;
    const withSeeder = [INIT_SCRIPTS[0], seeder, ...INIT_SCRIPTS.slice(1)];
    const { local } = runInitScripts(withSeeder);
    expect(local.getItem("seeded-by-a-later-init-script")).toBe("kept");
  });

  it("does not throw when the origin has storage disabled", () => {
    expect(() => runInitScripts([CLEAR_STORAGE], { storageThrows: true })).not.toThrow();
  });
});
