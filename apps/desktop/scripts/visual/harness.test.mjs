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
import { parseArgs } from "./capture.mjs";
import { mockChromeCss, resolveMock } from "./compare.mjs";

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

  it("reports a clear error when neither the tree nor any ref carries the mock", () => {
    // MUST POINT AT A REPO ROOT WITHOUT THE MOCK. This passed only while the mock lived on another
    // branch: `resolveMock` checks the WORKING TREE before it ever looks at `refs`, so once the
    // mock landed here the bad ref list stopped being reached and the call succeeded. The test was
    // asserting the error path while exercising the happy one — it was the mock's absence doing
    // the work, not the argument.
    const empty = mkdtempSync(join(tmpdir(), "visual-noroot-"));
    expect(() =>
      resolveMock(undefined, { repoRoot: empty, refs: ["definitely-not-a-ref"] }),
    ).toThrow(/Could not find .*rev4-standalone\.html/);
  });

  // HARD ASSERTION NOW. This was deliberately soft — a try/catch that warned and returned — because
  // rev4-standalone.html lived only on a feature branch and its absence on a fresh clone was an
  // environment fact rather than a defect. It is in the tree on this branch, so the skip would now
  // only ever hide a real breakage in the tree lookup.
  it("locates the approved mock", () => {
    const found = resolveMock();
    expect(found.html).toContain('class="shell"');
    expect(found.html).toContain("data-wired");
  });

  it("rejects an explicit --mock path that does not exist", () => {
    expect(() => resolveMock("/tmp/nope-does-not-exist.html")).toThrow(/does not exist/);
  });
});
