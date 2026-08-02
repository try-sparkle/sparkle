// Tests for the visual harness's pure logic — the PNG codec, the diff arithmetic, and the surface
// registry. Everything that touches Chrome is excluded on purpose: those parts are proven by
// actually running `visual:capture`, while THESE are the parts whose silent misbehaviour would
// produce a confident, wrong number.
//
// Picked up by the desktop vitest run (its default include covers scripts/), so
// `pnpm --filter @sparkle/desktop test` exercises them.

import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
      "open-pr-menu-narrow",
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
