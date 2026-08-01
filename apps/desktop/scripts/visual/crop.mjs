#!/usr/bin/env node
// crop — cut a region out of a capture, optionally magnified, so a seam can be LOOKED at.
//
//   node scripts/visual/crop.mjs shot.png --x=680..820 --y=180..320 --zoom=4 --out=seam.png
//
// Companion to seam-probe.mjs: that one settles what the pixels ARE, this one makes them visible to
// a human. Nearest-neighbour magnification on purpose — a smoothed zoom invents intermediate
// colours, which is precisely what makes a 1px rule arguable.

import { readFileSync, writeFileSync } from "node:fs";
import { decodePng, encodePng } from "./png.mjs";
import { parseArgs, parseRange } from "./seam-probe.mjs";

/** Cut `[x0..x1] × [y0..y1]` out of an image, magnified `zoom`× by pixel replication. */
export function crop(img, { x0, x1, y0, y1, zoom = 1 }) {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w <= 0 || h <= 0) throw new Error(`empty crop ${w}×${h}`);
  if (x0 < 0 || y0 < 0 || x1 >= img.width || y1 >= img.height) {
    throw new Error(`crop ${x0}..${x1} × ${y0}..${y1} falls outside ${img.width}×${img.height}`);
  }
  const out = { width: w * zoom, height: h * zoom, data: Buffer.alloc(w * zoom * h * zoom * 4) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y + y0) * img.width + (x + x0)) * 4;
      for (let dy = 0; dy < zoom; dy++) {
        for (let dx = 0; dx < zoom; dx++) {
          const di = ((y * zoom + dy) * out.width + (x * zoom + dx)) * 4;
          img.data.copy(out.data, di, si, si + 4);
        }
      }
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file || !args.out) {
    console.error("usage: crop.mjs <shot.png> --x=<from..to> --y=<from..to> [--zoom=N] --out=<file>");
    process.exit(2);
  }
  const img = decodePng(readFileSync(file));
  const xr = parseRange(args.x, "x");
  const yr = parseRange(args.y, "y");
  const zoom = args.zoom === undefined ? 1 : Number(args.zoom);
  if (!Number.isInteger(zoom) || zoom < 1) throw new Error(`--zoom must be a positive integer (got ${args.zoom})`);
  const out = crop(img, { x0: xr.from, x1: xr.to, y0: yr.from, y1: yr.to, zoom });
  writeFileSync(args.out, encodePng(out));
  console.log(`${args.out} — ${out.width}×${out.height} (${xr.from}..${xr.to} × ${yr.from}..${yr.to} @ ${zoom}×)`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();
