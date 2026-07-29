// A small PNG decoder/encoder — enough for the visual harness, and nothing more.
//
// WHY NOT pngjs / sharp / pixelmatch: this file is ~180 lines against zlib, which node already has.
// Chrome emits exactly one PNG flavour from Page.captureScreenshot (8-bit, non-interlaced, RGB or
// RGBA), so a general-purpose decoder would be carrying support for 1/2/4/16-bit, palettes, Adam7
// and tRNS that this harness will never see. Adding a dependency to a measuring instrument also
// means the instrument stops working the day an install is skipped — which is precisely how
// scripts/screenshot.mjs came to be dead code in this worktree.
//
// Unsupported inputs throw with a specific message rather than silently mis-decoding.

import { inflateSync, deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32, table built once. Required for both reading validation and writing chunks. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Undo one scanline's filter, in place. `bpp` is bytes per pixel; `prev` is the line above. */
function unfilter(type, line, prev, bpp) {
  const n = line.length;
  switch (type) {
    case 0:
      break;
    case 1: // Sub
      for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      break;
    case 2: // Up
      for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 0xff;
      break;
    case 3: // Average
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      break;
    case 4: // Paeth
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pred) & 0xff;
      }
      break;
    default:
      throw new Error(`PNG: unknown filter type ${type}`);
  }
}

/**
 * Decode a PNG buffer to `{ width, height, data }` where `data` is RGBA, 4 bytes per pixel.
 * Always RGBA on the way out, whatever the source colour type, so callers never branch.
 */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("PNG: bad signature — not a PNG");
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let palette = null;

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "PLTE") {
      palette = Buffer.from(body);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len; // length + type + body + crc
  }

  if (bitDepth !== 8) throw new Error(`PNG: only 8-bit is supported (got ${bitDepth}-bit)`);
  if (interlace !== 0) throw new Error("PNG: interlaced images are not supported");

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`PNG: unsupported colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error("PNG: indexed image with no PLTE chunk");

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels; // 8-bit, so bytes-per-pixel === channels
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let rp = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    unfilter(filter, line, prev, bpp);
    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      switch (colorType) {
        case 0: // grayscale
          out[d] = out[d + 1] = out[d + 2] = line[s];
          out[d + 3] = 255;
          break;
        case 2: // RGB
          out[d] = line[s];
          out[d + 1] = line[s + 1];
          out[d + 2] = line[s + 2];
          out[d + 3] = 255;
          break;
        case 3: // indexed
          out[d] = palette[line[s] * 3];
          out[d + 1] = palette[line[s] * 3 + 1];
          out[d + 2] = palette[line[s] * 3 + 2];
          out[d + 3] = 255;
          break;
        case 4: // grayscale + alpha
          out[d] = out[d + 1] = out[d + 2] = line[s];
          out[d + 3] = line[s + 1];
          break;
        default: // 6, RGBA
          out[d] = line[s];
          out[d + 1] = line[s + 1];
          out[d + 2] = line[s + 2];
          out[d + 3] = line[s + 3];
      }
    }
    prev = line;
  }
  return { width, height, data: out };
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/**
 * Encode RGBA pixels to a PNG buffer. Every scanline is written with filter 0 (None): the output is
 * a human-facing side-by-side or diff image, so decode simplicity beats a few percent of file size.
 */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
