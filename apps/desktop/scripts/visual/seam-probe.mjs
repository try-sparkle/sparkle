#!/usr/bin/env node
// seam-probe — read the PIXELS across a boundary and say what is actually painted there.
//
//   node scripts/visual/seam-probe.mjs shot.png --y=245 --x=700..800
//   node scripts/visual/seam-probe.mjs shot.png --y=245 --x=700..800 --json
//
// WHY THIS EXISTS
// Five rounds of "the vertical line is fixed" shipped without anyone reading a rendered pixel. Every
// one of them reasoned from the SOURCE — "I removed the border, therefore the line is gone" — which
// cannot see a line painted by a different element, a background gap, a shadow, or a scroll
// container's edge. A seam is a claim about pixels, so it has to be settled in pixels.
//
// WHAT IT REPORTS
// A horizontal scan is collapsed into RUNS of near-identical colour. A 1px rule between two planes
// shows up unmissably as a short run whose colour is neither neighbour:
//
//   x  700..745  #0e1b2e  (46px)
//   x  746..747  #24406a  (2px)   <-- the seam, at scale 2
//   x  748..800  #101f36  (53px)
//
// A CONTINUOUS join is exactly two runs meeting, or one run straight through. `--json` emits the
// same data for a test to assert on, which is what makes "no seam" a regression-testable fact
// rather than a screenshot someone looked at once.
//
// SCALE. Captures are taken at devicePixelRatio 2 by default, so a 1 CSS-px rule is 2 image px and
// a run of 1-2px is the signature to look for. Pass --scale to have widths reported in CSS px too.

import { readFileSync } from "node:fs";
import { decodePng } from "./png.mjs";

/** `--key=value` / bare `--flag`. Pure, so the CLI contract is unit-testable. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}

/** `700..800` or `700-800` or a bare `700` (meaning just that column). Inclusive on both ends. */
export function parseRange(raw, name) {
  if (raw === undefined || raw === true) throw new Error(`--${name} is required, e.g. --${name}=700..800`);
  const m = /^(\d+)(?:\s*(?:\.\.|-)\s*(\d+))?$/.exec(String(raw).trim());
  if (!m) throw new Error(`--${name} must be N or N..M (got ${JSON.stringify(raw)})`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (to < from) throw new Error(`--${name} range is inverted (${from}..${to})`);
  return { from, to };
}

export function toHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Read one pixel. Throws rather than returning black for out-of-bounds — a silent 0 reads as a real
 *  colour and would turn a bad coordinate into a confident wrong answer. */
export function pixelAt(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) {
    throw new Error(`(${x},${y}) is outside the ${img.width}×${img.height} image`);
  }
  const i = (y * img.width + x) * 4;
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] };
}

/** Max per-channel difference. The metric is deliberately max-abs, not a mean: a 1px rule that
 *  differs in ONE channel is still a visible line, and averaging is how it gets rounded away. */
export function channelDelta(p, q) {
  return Math.max(Math.abs(p.r - q.r), Math.abs(p.g - q.g), Math.abs(p.b - q.b));
}

/**
 * Collapse a row of pixels into runs of near-identical colour.
 *
 * `tolerance` is compared against the run's ANCHOR (its first pixel), not its previous pixel.
 * Chained comparison lets a gradient drift arbitrarily far while every adjacent step stays under
 * tolerance — which would swallow exactly the soft 2-3px shadow edge this tool exists to catch.
 */
export function runsOf(pixels, tolerance = 2) {
  const runs = [];
  for (const px of pixels) {
    const last = runs[runs.length - 1];
    if (last && channelDelta(last.color, px) <= tolerance) {
      last.width += 1;
      continue;
    }
    runs.push({ color: px, width: 1 });
  }
  return runs;
}

/** Scan one horizontal band and return its runs, with absolute x positions attached. */
export function scanRow(img, y, xFrom, xTo, tolerance) {
  const pixels = [];
  for (let x = xFrom; x <= xTo; x++) pixels.push(pixelAt(img, x, y));
  let x = xFrom;
  return runsOf(pixels, tolerance).map((run) => {
    const at = { from: x, to: x + run.width - 1, ...run, hex: toHex(run.color) };
    x += run.width;
    return at;
  });
}

/**
 * The verdict. A boundary is CONTINUOUS when the scan is one run, or two runs meeting directly.
 * Anything else means a distinct band sits between the two planes — which is the defect.
 *
 * TWO WAYS A BAND COUNTS AS A SEAM, and the second is the one that matters here:
 *
 *  1. It is NARROW (<= `maxInterloperWidth`). This is the classic 1px rule — 2px at the harness's
 *     default devicePixelRatio of 2.
 *  2. THE SCAN STARTS AND ENDS ON THE SAME PLANE. If the colour either side of the band is the
 *     same, the band is by definition an interruption of one continuous surface, however wide it
 *     is. A width-only rule reported the real defect here as "continuous": the gutter between the
 *     concierge and the mounted row is 7 CSS px (14 image px), comfortably over any sane rule
 *     width, while the plane on both sides was byte-identical. Judging a join by the width of what
 *     splits it is exactly the mistake that let five rounds of this ship.
 *
 * A scan that merely crosses three genuinely different panels still passes: its ends differ, and
 * the middle is too wide to be a rule.
 *
 * ── `strict`: WHEN "TWO RUNS MEETING" IS ITSELF THE DEFECT ────────────────────────────────────
 * The default is the PANEL BOUNDARY question — "is there a rule between these two surfaces" — and
 * two runs meeting is the correct answer there. It is the WRONG answer for a JOINT, where the whole
 * claim is that one plane runs through unbroken. If the row's plane later drifts off the `forest`
 * token while the fill and the concierge keep it, the scan collapses to `[row][fill+concierge]` — a
 * hard colour step straight down the join — with no middle run for `sameEnds` to flag, and the
 * default rule reports `continuous: true` (roborev 57327).
 *
 * So `strict` demands a SINGLE run. `runCount` is returned either way, so a caller can make that
 * judgement itself without re-deriving it from the runs array.
 */
export function verdict(runs, maxInterloperWidth = 6, tolerance = 2, { strict = false } = {}) {
  // The ends of a one-run scan are trivially identical, and reporting `false` there made the field
  // useless to a JSON consumer trying to discriminate the two shapes.
  const sameEnds =
    runs.length > 0 && channelDelta(runs[0].color, runs[runs.length - 1].color) <= tolerance;
  const middle = runs.slice(1, -1);
  const interlopers = middle.filter((r) => sameEnds || r.width <= maxInterloperWidth);
  // EXACTLY one, not "at most one": an empty scan has nothing to be continuous ACROSS, and
  // answering `true` there is the same confident-wrong-answer `pixelAt` refuses to give for an
  // out-of-bounds read (roborev 57352).
  const continuous = strict ? runs.length === 1 : runs.length > 0 && interlopers.length === 0;
  return { continuous, interlopers, sameEnds, runCount: runs.length };
}

/**
 * Does this invocation want the JOINT question rather than the panel-boundary one?
 *
 * `--strict` is load-bearing: it is the criterion this branch's seam proof is stated under, and how
 * the next person re-verifies the join. Exported so the flag's resolution is assertable.
 */
export function wantsStrict(args) {
  return args.strict === true || args.strict === "true";
}

/**
 * The WHOLE argv → options mapping, in one exported place.
 *
 * EXTRACTING `wantsStrict` ALONE ONLY MOVED THE UNTESTED SEAM ONE FRAME OUT. `wantsStrict` and
 * `probeRows` were both covered, but the line that JOINED them lived in the unexported `main()`, so
 * replacing `strict: wantsStrict(args)` with `strict: false` left the entire suite green while
 * `--strict` on the command line degraded to the permissive rule — the same failure, one call frame
 * further out (roborev 57377). That line was also the only place `xr`/`yr`/`tolerance` were mapped
 * onto `probeRows`' parameter names, so a transposed `xFrom`/`yFrom` was equally invisible.
 *
 * With the mapping here, `main()` is `probeRows(img, probeOptions(args))` and has nothing left to
 * mutate silently.
 */
export function probeOptions(args) {
  const xr = parseRange(args.x, "x");
  const yr = parseRange(args.y, "y");
  return {
    yFrom: yr.from,
    yTo: yr.to,
    xFrom: xr.from,
    xTo: xr.to,
    tolerance: args.tolerance === undefined ? 2 : Number(args.tolerance),
    strict: wantsStrict(args),
  };
}

/** Scan every row in `yFrom..yTo` and judge each. The whole body of the CLI, exported so an
 *  end-to-end case can drive it over a synthetic image without spawning a process. */
export function probeRows(img, { yFrom, yTo, xFrom, xTo, tolerance = 2, strict = false }) {
  const rows = [];
  for (let y = yFrom; y <= yTo; y++) {
    const runs = scanRow(img, y, xFrom, xTo, tolerance);
    rows.push({ y, runs, ...verdict(runs, 6, tolerance, { strict }) });
  }
  return rows;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file) {
    console.error("usage: seam-probe.mjs <shot.png> --y=<row> --x=<from..to> [--tolerance=2] [--strict] [--json]");
    process.exit(2);
  }
  const img = decodePng(readFileSync(file));
  const opts = probeOptions(args);
  const rows = probeRows(img, opts);

  if (args.json) {
    console.log(JSON.stringify({ file, width: img.width, height: img.height, rows }, null, 2));
    return;
  }

  console.log(`${file} — ${img.width}×${img.height}`);
  for (const row of rows) {
    console.log(`\ny=${row.y}  x ${opts.xFrom}..${opts.xTo}`);
    for (const r of row.runs) {
      const flag = !row.continuous && row.interlopers.includes(r) ? "   <-- SEAM" : "";
      console.log(
        `  x ${String(r.from).padStart(5)}..${String(r.to).padEnd(5)} ${r.hex}  (${r.width}px)${flag}`,
      );
    }
    // A strict run that fails with NO interloper is the two-planes-meeting case, and saying
    // "0 interloping bands" there would read as a pass. Name what actually failed.
    const why = row.interlopers.length
      ? `${row.interlopers.length} interloping band(s)`
      : `${row.runCount} runs — a colour step at the join (strict)`;
    console.log(row.continuous ? "  VERDICT: continuous" : `  VERDICT: ${why}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();
