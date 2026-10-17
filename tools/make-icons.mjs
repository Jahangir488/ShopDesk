#!/usr/bin/env node
// Generate the PWA / home-screen icons as PNGs without any image libraries.
//   node tools/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "icons");
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b; raw[offset + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const COLORS = {
  bg: [23, 67, 61],      // sidebar green
  bgDeep: [18, 53, 49],
  accent: [242, 183, 5],  // brand yellow
  accentDark: [214, 158, 0],
  paper: [242, 244, 246],
  green: [86, 211, 120],
  ink: [31, 35, 40]
};

// Draw the shop-front mark on a 512x512 design grid, then scale.
function design(theme = "normal") {
  return (px, py) => {
    const x = (px / 512) * 512, y = (py / 512) * 512;
    const s = 512 / 512;
    // background (full bleed so maskable icons crop nicely)
    let color = COLORS.bg;
    // subtle vertical gradient
    const t = y / 512;
    color = [
      Math.round(COLORS.bg[0] + (COLORS.bgDeep[0] - COLORS.bg[0]) * t),
      Math.round(COLORS.bg[1] + (COLORS.bgDeep[1] - COLORS.bg[1]) * t),
      Math.round(COLORS.bg[2] + (COLORS.bgDeep[2] - COLORS.bg[2]) * t)
    ];
    if (theme === "maskable") color = COLORS.bg;

    const inside = (x1, y1, x2, y2) => x >= x1 * s && x <= x2 * s && y >= y1 * s && y <= y2 * s;
    // awning (trapezoid)
    if (y >= 150 * s && y <= 232 * s) {
      const inset = 96 + ((232 - 150) - (y / s - 150)) * 0.55;
      const left = Math.min(150, inset + 20);
      if (x >= (150 - (y / s - 150) * 0.35) * s && x <= (362 + (y / s - 150) * 0.35) * s) color = COLORS.accent;
    }
    // awning stripes
    if (y >= 150 * s && y <= 232 * s && x >= 96 * s && x <= 416 * s) {
      const stripe = Math.floor(((x / s) - 96) / 40) % 2 === 0;
      if (stripe) color = COLORS.accent;
      else color = COLORS.accentDark;
    }
    // shop body
    if (inside(132, 232, 380, 400)) color = COLORS.paper;
    // windows
    if (inside(158, 262, 222, 322)) color = COLORS.green;
    if (inside(290, 262, 354, 322)) color = COLORS.green;
    // door
    if (inside(232, 300, 280, 400)) color = COLORS.bg;
    // door handle
    if (inside(270, 344, 276, 358)) color = COLORS.accent;
    // base shadow
    if (inside(120, 400, 392, 412)) color = COLORS.bgDeep;
    return [...color, 255];
  };
}

const sizes = [
  ["icon-192.png", 192, design()],
  ["icon-512.png", 512, design()],
  ["icon-maskable-512.png", 512, design("maskable")],
  ["apple-touch-icon.png", 180, design()]
];
for (const [name, size, pixel] of sizes) {
  writeFileSync(join(outDir, name), png(size, size, pixel));
  console.log("wrote", join("icons", name), `${size}x${size}`);
}

// favicon (32x32 PNG served as /icons/favicon.png)
writeFileSync(join(outDir, "favicon.png"), png(32, 32, design()));
console.log("wrote icons/favicon.png 32x32");
