// Tests for the visual harness's pure logic — the PNG codec, the diff arithmetic, and the surface
// registry. Everything that touches Chrome is excluded on purpose: those parts are proven by
// actually running `visual:capture`, while THESE are the parts whose silent misbehaviour would
// produce a confident, wrong number.
//
// Picked up by the desktop vitest run (its default include covers scripts/), so
// `pnpm --filter @sparkle/desktop test` exercises them.

import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { numericArg, parseArgs } from "./capture.mjs";
import { mockChromeCss, resolveMock, viewportFromManifest } from "./compare.mjs";
import { compareDirs } from "./verify-stable.mjs";

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
      "concierge-column",
      "settings-dialog",
    ]);
    expect(THEMES).toEqual(["light", "dark"]);
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

  it("has unique surface names — artifacts are keyed on them", () => {
    expect(new Set(SURFACES.map((s) => s.name)).size).toBe(SURFACES.length);
  });

  it("resolves and filters surfaces by name", () => {
    expect(selectSurfaces(null)).toHaveLength(SURFACES.length);
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
      resolveMock(undefined, { repoRoot: emptyRoot, refs: ["definitely-not-a-ref"] }),
    ).toThrow(/Could not find .*rev4-standalone\.html/);
  });

  // HARD ASSERTION. This was deliberately soft — a try/catch that warned and returned — on the
  // stated premise that "rev4-standalone.html has not landed on main". It has: the mock landed with
  // the cockpit port, so it is in the working tree on every branch cut from main and the skip can
  // now only ever hide a real breakage in the tree lookup. The soft form outliving its premise is
  // the same shape as the assertion above, which passed only because the mock was absent.
  it("locates the approved mock", () => {
    const found = resolveMock();
    expect(found.html).toContain('class="shell"');
    expect(found.html).toContain("data-wired");
  });

  it("rejects an explicit --mock path that does not exist", () => {
    expect(() => resolveMock("/tmp/nope-does-not-exist.html")).toThrow(/does not exist/);
  });
});
