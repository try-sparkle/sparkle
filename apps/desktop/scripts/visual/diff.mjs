// Pixel comparison and the two human-facing images the harness emits.
//
// Everything here is a pure function over `{width, height, data}` RGBA images — no browser, no
// filesystem — so the number the harness reports is unit-testable rather than eyeballed.

/**
 * How different two channel-triples are, as the largest single-channel gap (Chebyshev distance).
 * Chosen over a Euclidean/luminance metric because it is what a threshold means intuitively:
 * "no channel is off by more than N". Alpha is composited against the caller's background first,
 * so it never contributes here.
 */
function channelDelta(a, b, i, j) {
  const dr = Math.abs(a[i] - b[j]);
  const dg = Math.abs(a[i + 1] - b[j + 1]);
  const db = Math.abs(a[i + 2] - b[j + 2]);
  return Math.max(dr, dg, db);
}

/**
 * Compare two images.
 *
 * SIZE MISMATCH IS A REAL RESULT, NOT AN ERROR. The app's surface and the mock's are routinely
 * different sizes — that IS a fidelity finding, and refusing to compare would hide it. So the
 * overlap is compared pixel-by-pixel and every pixel outside it counts as differing, against a
 * denominator of the union area. A surface half the height it should be therefore scores ~50%
 * before a single colour is examined, which is the honest reading.
 *
 * `threshold` is the per-channel tolerance (0–255). It defaults to 0 — exact — because the harness
 * pins device scale, disables subpixel text positioning and hinting, and freezes animation, so
 * there is no legitimate source of ±1 noise between two runs of the SAME page. Raise it only when
 * comparing across renderers.
 */
export function compareImages(a, b, { threshold = 0 } = {}) {
  const ow = Math.min(a.width, b.width);
  const oh = Math.min(a.height, b.height);
  const unionW = Math.max(a.width, b.width);
  const unionH = Math.max(a.height, b.height);
  const total = unionW * unionH;

  let differing = total - ow * oh; // everything outside the overlap
  let maxDelta = 0;
  let sumDelta = 0;

  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      const d = channelDelta(a.data, b.data, i, j);
      if (d > maxDelta) maxDelta = d;
      sumDelta += d;
      if (d > threshold) differing++;
    }
  }

  const overlap = ow * oh;
  const overlapDiffering = differing - (total - overlap);

  return {
    width: unionW,
    height: unionH,
    sameSize: a.width === b.width && a.height === b.height,
    aSize: { width: a.width, height: a.height },
    bSize: { width: b.width, height: b.height },
    total,
    differing,
    /**
     * The headline number: percentage of differing pixels over the UNION, 2 dp.
     *
     * Read it with `overlapPercent`, not alone. When two surfaces are different sizes this
     * saturates at or near 100% no matter how similar the shared region is — which is correct
     * (a surface of the wrong size IS wholly wrong) but gives no gradient to improve against.
     */
    percent: total === 0 ? 0 : Number(((differing / total) * 100).toFixed(2)),
    /**
     * Percentage of differing pixels within the OVERLAPPING region only. This is the number that
     * moves as the design converges; `percent` is the number that says whether the geometry is
     * right at all. Reporting only one of them hides half the finding.
     */
    overlap,
    overlapDiffering,
    overlapPercent: overlap === 0 ? 0 : Number(((overlapDiffering / overlap) * 100).toFixed(2)),
    maxDelta,
    meanDelta: overlap === 0 ? 0 : Number((sumDelta / overlap).toFixed(2)),
  };
}

/** A blank RGBA canvas filled with one colour. */
export function blank(width, height, [r, g, bl, al] = [0, 0, 0, 255]) {
  const data = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    data[p * 4] = r;
    data[p * 4 + 1] = g;
    data[p * 4 + 2] = bl;
    data[p * 4 + 3] = al;
  }
  return { width, height, data };
}

/** Copy `src` into `dst` with its top-left at (dx, dy), clipped to `dst`'s bounds. */
export function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dst.width + tx) * 4;
      dst.data[d] = src.data[s];
      dst.data[d + 1] = src.data[s + 1];
      dst.data[d + 2] = src.data[s + 2];
      dst.data[d + 3] = src.data[s + 3];
    }
  }
  return dst;
}

/**
 * The two images laid out left (app) | right (mock) on a neutral field, with a gutter between them.
 * Sized to the taller of the two so neither is cropped.
 */
export function sideBySide(appImg, mockImg, { gutter = 24, background = [24, 26, 30, 255] } = {}) {
  const width = appImg.width + gutter + mockImg.width;
  const height = Math.max(appImg.height, mockImg.height);
  const canvas = blank(width, height, background);
  blit(canvas, appImg, 0, 0);
  blit(canvas, mockImg, appImg.width + gutter, 0);
  return canvas;
}

/**
 * The difference image: matching pixels dimmed to a faint grayscale ghost, differing ones painted
 * magenta. The ghost matters — a pure black-and-white mask tells you a pixel differs but not
 * *where in the layout*, which is the thing you actually need in order to fix it.
 *
 * Non-overlapping regions are painted magenta too, matching how compareImages counts them.
 */
export function diffImage(a, b, { threshold = 0, highlight = [255, 0, 200] } = {}) {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const out = blank(width, height, [...highlight, 255]);
  const ow = Math.min(a.width, b.width);
  const oh = Math.min(a.height, b.height);

  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      const d = (y * width + x) * 4;
      if (channelDelta(a.data, b.data, i, j) > threshold) {
        out.data[d] = highlight[0];
        out.data[d + 1] = highlight[1];
        out.data[d + 2] = highlight[2];
      } else {
        // Rec. 601 luma, lifted toward white so the ghost reads under the magenta.
        const l = 0.299 * a.data[i] + 0.587 * a.data[i + 1] + 0.114 * a.data[i + 2];
        const g = Math.round(l * 0.35 + 160);
        out.data[d] = out.data[d + 1] = out.data[d + 2] = g;
      }
      out.data[d + 3] = 255;
    }
  }
  return out;
}
