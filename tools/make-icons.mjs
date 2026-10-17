#!/usr/bin/env node
// Generate the Shop Desk PWA, offline-page and Windows shortcut icons without
// image dependencies.  `node tools/make-icons.mjs`
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

const C = {
  deep: [18, 53, 49],
  light: [27, 83, 73],
  paper: [249, 251, 248],
  paperShade: [231, 240, 235],
  ink: [24, 65, 59],
  mint: [77, 210, 133],
  mintLight: [164, 239, 191],
  gold: [248, 190, 32],
  goldShade: [224, 157, 16]
};

function roundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}
function circle(x, y, cx, cy, radius) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

// A contemporary cash-register / sales-ledger mark: the pale register body,
// live-screen bars and gold receipt remain legible at both home-screen and
// small Windows shortcut sizes.
function design(artScale = 1) {
  return (px, py, size) => {
    const sourceX = (px + 0.5) * 512 / size;
    const sourceY = (py + 0.5) * 512 / size;
    const x = 256 + (sourceX - 256) / artScale;
    const y = 256 + (sourceY - 256) / artScale;
    const mix = (a, b, t) => a.map((value, index) => Math.round(value + (b[index] - value) * t));
    const centerGlow = Math.max(0, 1 - Math.hypot(x - 250, y - 235) / 400);
    let color = mix(C.deep, C.light, centerGlow * 0.58);

    // Soft circular halo behind the mark.
    if (circle(x, y, 256, 246, 194)) color = mix(color, [36, 111, 92], 0.22);

    // Receipt peeking above the register, with a simple printed sales chart.
    if (roundedRect(x, y, 302, 78, 408, 253, 22)) color = C.paperShade;
    if (roundedRect(x, y, 316, 92, 394, 229, 13)) color = C.paper;
    if (roundedRect(x, y, 329, 111, 381, 118, 3)) color = C.gold;
    if (roundedRect(x, y, 329, 132, 376, 139, 3)) color = [175, 191, 183];
    if (roundedRect(x, y, 329, 149, 376, 156, 3)) color = [175, 191, 183];
    if (roundedRect(x, y, 329, 166, 376, 173, 3)) color = [175, 191, 183];
    if (roundedRect(x, y, 329, 189, 340, 216, 4)) color = C.mint;
    if (roundedRect(x, y, 346, 179, 357, 216, 4)) color = C.mint;
    if (roundedRect(x, y, 363, 171, 374, 216, 4)) color = C.gold;

    // Cash register base and a dark, high-contrast display.
    if (roundedRect(x, y, 84, 174, 424, 420, 46)) color = C.paper;
    if (roundedRect(x, y, 111, 198, 397, 306, 24)) color = C.ink;
    // Three ascending sales bars on the display.
    if (roundedRect(x, y, 151, 261, 190, 286, 8)) color = C.mint;
    if (roundedRect(x, y, 210, 240, 249, 286, 8)) color = C.mint;
    if (roundedRect(x, y, 269, 220, 308, 286, 8)) color = C.gold;
    // Display baseline.
    if (roundedRect(x, y, 143, 289, 314, 295, 3)) color = [94, 136, 123];

    // Tactile keypad and one gold checkout key.
    for (const left of [126, 187, 248]) {
      for (const top of [326, 365]) {
        if (roundedRect(x, y, left, top, left + 43, top + 23, 8)) color = C.paperShade;
      }
    }
    if (roundedRect(x, y, 309, 326, 379, 365, 12)) color = C.gold;
    if (roundedRect(x, y, 309, 374, 379, 391, 8)) color = C.mintLight;

    // Short shadow under the register gives the flat mark a little depth.
    if (roundedRect(x, y, 137, 414, 371, 427, 6)) color = [9, 39, 36];
    return [...color, 255];
  };
}

const iconPixel = design();
const maskablePixel = design(0.78); // keep the mark inside the OS mask-safe circle
for (const [name, size, pixel] of [
  ["icon-192.png", 192, iconPixel],
  ["icon-512.png", 512, iconPixel],
  ["icon-maskable-512.png", 512, maskablePixel],
  ["apple-touch-icon.png", 180, iconPixel]
]) {
  writeFileSync(join(outDir, name), png(size, size, (x, y) => pixel(x, y, size)));
  console.log("wrote", join("icons", name), `${size}x${size}`);
}
const favicon = png(32, 32, (x, y) => iconPixel(x, y, 32));
writeFileSync(join(outDir, "favicon.png"), favicon);
console.log("wrote icons/favicon.png 32x32");

// Windows Vista and later accept PNG-compressed images in ICO files. This gives
// the desktop Internet shortcuts the same full-colour Shop Desk mark as the PWA.
const ico = Buffer.alloc(22 + png(256, 256, (x, y) => iconPixel(x, y, 256)).length);
ico.writeUInt16LE(0, 0);       // reserved
ico.writeUInt16LE(1, 2);        // icon resource
ico.writeUInt16LE(1, 4);        // one image
ico[6] = 0; ico[7] = 0;         // 256 x 256 (zero encodes 256)
ico[8] = 0; ico[9] = 0;         // true colour
ico.writeUInt16LE(1, 10);       // planes
ico.writeUInt16LE(32, 12);      // bits per pixel
const icoPng = png(256, 256, (x, y) => iconPixel(x, y, 256));
ico.writeUInt32LE(icoPng.length, 14);
ico.writeUInt32LE(22, 18);
icoPng.copy(ico, 22);
writeFileSync(join(outDir, "shopdesk.ico"), ico);
console.log("wrote icons/shopdesk.ico 256x256");
