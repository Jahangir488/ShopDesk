// Minimal QR Code encoder (byte mode, versions 1-10, error correction L and M).
// Used for the "Connect a device" QR code. No dependencies, no network access.
// The output is verified against the reference `qrcode` package by tools/verify-qr.mjs.

const ECC_LEVELS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
const FORMAT_ECL_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

// [ecCodewordsPerBlock, blocksInGroup1, dataCodewordsGroup1, blocksInGroup2, dataCodewordsGroup2]
const RS_BLOCKS = {
  L: {
    1: [7, 1, 19, 0, 0], 2: [10, 1, 34, 0, 0], 3: [15, 1, 55, 0, 0], 4: [20, 1, 80, 0, 0],
    5: [26, 1, 108, 0, 0], 6: [18, 2, 68, 0, 0], 7: [20, 2, 78, 0, 0], 8: [24, 2, 97, 0, 0],
    9: [30, 2, 116, 0, 0], 10: [18, 2, 68, 2, 69]
  },
  M: {
    1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0], 4: [18, 2, 32, 0, 0],
    5: [24, 2, 43, 0, 0], 6: [16, 4, 27, 0, 0], 7: [18, 4, 31, 0, 0], 8: [22, 2, 38, 2, 39],
    9: [22, 3, 36, 2, 37], 10: [26, 4, 43, 1, 44]
  }
};
const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function buildGaloisField() {
  let value = 1;
  for (let index = 0; index < 255; index++) {
    GF_EXP[index] = value;
    GF_LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index++) GF_EXP[index] = GF_EXP[index - 255];
})();

function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function reedSolomonDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index++) {
    for (let position = 0; position < degree; position++) {
      result[position] = gfMultiply(result[position], root);
      if (position + 1 < degree) result[position] ^= result[position + 1];
    }
    root = gfMultiply(root, 2);
  }
  return result;
}

function reedSolomonRemainder(data, degree) {
  const divisor = reedSolomonDivisor(degree);
  const result = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let index = 0; index < degree; index++) result[index] ^= gfMultiply(divisor[index], factor);
  }
  return result;
}

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text));
}

function capacityBits(version, level) {
  const [ec, blocks1, data1, blocks2, data2] = RS_BLOCKS[level][version];
  return (blocks1 * data1 + blocks2 * data2) * 8;
}

function chooseVersion(byteLength, level, minVersion = 1) {
  for (let version = Math.max(1, minVersion); version <= 10; version++) {
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= capacityBits(version, level)) return version;
  }
  throw new RangeError("This text is too long for a version 1-10 QR code.");
}

function buildCodewords(text, version, level) {
  const bytes = utf8Bytes(text);
  const countBits = version < 10 ? 8 : 16;
  const totalBits = capacityBits(version, level);
  const bits = [];
  const push = (value, length) => { for (let index = length - 1; index >= 0; index--) bits.push((value >>> index) & 1); };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits);
  for (const byte of bytes) push(byte, 8);
  const needed = capacityBits(version, level);
  for (let index = 0; index < Math.min(4, needed - bits.length); index++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let offset = 0; offset < 8; offset++) value = (value << 1) | bits[index + offset];
    data.push(value);
  }
  const [ecCodewords, blocks1, data1, blocks2, data2] = RS_BLOCKS[level][version];
  const dataCapacity = blocks1 * data1 + blocks2 * data2;
  for (let pad = 0; data.length < dataCapacity; pad++) data.push(pad % 2 === 0 ? 0xec : 0x11);
  if (data.length !== dataCapacity) throw new Error("Internal QR data length mismatch.");

  const blocks = [];
  let cursor = 0;
  for (let block = 0; block < blocks1 + blocks2; block++) {
    const size = block < blocks1 ? data1 : data2;
    const chunk = Uint8Array.from(data.slice(cursor, cursor + size));
    cursor += size;
    blocks.push({ data: chunk, ec: reedSolomonRemainder(chunk, ecCodewords) });
  }
  const output = [];
  const maxData = Math.max(...blocks.map(block => block.data.length));
  for (let index = 0; index < maxData; index++) {
    for (const block of blocks) if (index < block.data.length) output.push(block.data[index]);
  }
  for (let index = 0; index < ecCodewords; index++) {
    for (const block of blocks) output.push(block.ec[index]);
  }
  return Uint8Array.from(output);
}

function bchFormatBits(level, mask) {
  const data = (FORMAT_ECL_BITS[level] << 3) | mask;
  let remainder = data << 10;
  for (let shift = 14; shift >= 10; shift--) {
    if ((remainder >>> shift) & 1) remainder ^= 0x537 << (shift - 10);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function bchVersionBits(version) {
  let remainder = version << 12;
  for (let shift = 17; shift >= 12; shift--) {
    if ((remainder >>> shift) & 1) remainder ^= 0x1f25 << (shift - 12);
  }
  return (version << 12) | remainder;
}

function maskBit(mask, row, column) {
  switch (mask) {
    case 0: return (row + column) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return column % 3 === 0;
    case 3: return (row + column) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5: return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6: return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    case 7: return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
    default: return false;
  }
}

function createMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFunctionPatterns(matrix, version, level, mask) {
  const size = matrix.length;
  const set = (row, column, dark) => {
    if (row >= 0 && row < size && column >= 0 && column < size) matrix[row][column] = dark ? 1 : 0;
  };
  // Finder patterns + separators
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let row = -1; row <= 7; row++) {
      for (let column = -1; column <= 7; column++) {
        const inside = row >= 0 && row <= 6 && column >= 0 && column <= 6;
        const dark = inside && (row === 0 || row === 6 || column === 0 || column === 6 || (row >= 2 && row <= 4 && column >= 2 && column <= 4));
        set(top + row, left + column, dark);
      }
    }
  }
  // Timing patterns
  for (let index = 8; index < size - 8; index++) {
    set(6, index, index % 2 === 0);
    set(index, 6, index % 2 === 0);
  }
  // Alignment patterns
  const positions = ALIGNMENT[version];
  for (let outer = 0; outer < positions.length; outer++) {
    for (let inner = 0; inner < positions.length; inner++) {
      if ((outer === 0 && inner === 0) || (outer === 0 && inner === positions.length - 1) || (outer === positions.length - 1 && inner === 0)) continue;
      const centerRow = positions[outer], centerColumn = positions[inner];
      for (let row = -2; row <= 2; row++) {
        for (let column = -2; column <= 2; column++) {
          set(centerRow + row, centerColumn + column, Math.max(Math.abs(row), Math.abs(column)) !== 1);
        }
      }
    }
  }
  // Format information (both copies)
  const format = bchFormatBits(level, mask);
  for (let index = 0; index < 15; index++) {
    const dark = ((format >> index) & 1) === 1;
    if (index < 6) set(index, 8, dark);
    else if (index < 8) set(index + 1, 8, dark);
    else set(size - 15 + index, 8, dark);
    if (index < 8) set(8, size - index - 1, dark);
    else if (index < 9) set(8, 15 - index, dark);
    else set(8, 15 - index - 1, dark);
  }
  set(size - 8, 8, true); // dark module
  // Version information for version 7 and above
  if (version >= 7) {
    const bits = bchVersionBits(version);
    for (let index = 0; index < 18; index++) {
      const dark = ((bits >> index) & 1) === 1;
      set(Math.floor(index / 3), (index % 3) + size - 11, dark);
      set((index % 3) + size - 11, Math.floor(index / 3), dark);
    }
  }
}

function placeData(matrix, codewords, mask) {
  const size = matrix.length;
  let byteIndex = 0, bitIndex = 7, row = size - 1, direction = -1;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column--;
    for (;;) {
      for (let offset = 0; offset < 2; offset++) {
        const targetColumn = column - offset;
        if (matrix[row][targetColumn] !== null) continue;
        let dark = false;
        if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
        if (maskBit(mask, row, targetColumn)) dark = !dark;
        matrix[row][targetColumn] = dark ? 1 : 0;
        bitIndex--;
        if (bitIndex < 0) { byteIndex++; bitIndex = 7; }
      }
      row += direction;
      if (row < 0 || row >= size) { row -= direction; direction = -direction; break; }
    }
  }
}

function penalty(matrix) {
  const size = matrix.length;
  let score = 0;
  const lines = [];
  for (let row = 0; row < size; row++) lines.push(matrix[row]);
  for (let column = 0; column < size; column++) lines.push(matrix.map(line => line[column]));
  for (const line of lines) {
    let run = 1;
    for (let index = 1; index < size; index++) {
      if (line[index] === line[index - 1]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
    for (let index = 0; index <= size - 7; index++) {
      if (line[index] && !line[index + 1] && line[index + 2] && line[index + 3] && line[index + 4] && !line[index + 5] && line[index + 6]) {
        const before = line.slice(Math.max(0, index - 4), index);
        const after = line.slice(index + 7, index + 11);
        if (before.length === 4 && before.every(value => !value)) score += 40;
        if (after.length === 4 && after.every(value => !value)) score += 40;
      }
    }
  }
  for (let row = 0; row < size - 1; row++) {
    for (let column = 0; column < size - 1; column++) {
      const value = matrix[row][column];
      if (value === matrix[row][column + 1] && value === matrix[row + 1][column] && value === matrix[row + 1][column + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const line of matrix) for (const value of line) dark += value;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** Encode text and return a square matrix of 0/1 numbers (no quiet zone). */
export function encodeQr(text, { errorCorrectionLevel = "M", version: forcedVersion = 0 } = {}) {
  const level = String(errorCorrectionLevel).toUpperCase();
  if (!RS_BLOCKS[level]) throw new RangeError("errorCorrectionLevel must be L or M.");
  const bytes = utf8Bytes(text);
  const version = forcedVersion || chooseVersion(bytes.length, level);
  if (version < 1 || version > 10) throw new RangeError("Only QR versions 1-10 are supported.");
  const codewords = buildCodewords(text, version, level);
  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const matrix = createMatrix(17 + version * 4);
    placeFunctionPatterns(matrix, version, level, mask);
    placeData(matrix, codewords, mask);
    const score = penalty(matrix);
    if (score < bestScore) { best = matrix; bestScore = score; }
  }
  return best;
}

export function qrSvg(text, { errorCorrectionLevel = "M", margin = 4, dark = "#1f2328", light = "#ffffff", size = 240, title = "QR code" } = {}) {
  const matrix = encodeQr(text, { errorCorrectionLevel });
  const dimension = matrix.length + margin * 2;
  const parts = [];
  for (let row = 0; row < matrix.length; row++) {
    let start = -1;
    for (let column = 0; column <= matrix.length; column++) {
      const filled = column < matrix.length && matrix[row][column] === 1;
      if (filled && start < 0) start = column;
      if (!filled && start >= 0) {
        parts.push(`M${start + margin} ${row + margin}h${column - start}v1h-${column - start}z`);
        start = -1;
      }
    }
  }
  const path = parts.join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges" role="img" aria-label="${escapeXml(title)}"><title>${escapeXml(title)}</title><rect width="${dimension}" height="${dimension}" fill="${escapeXml(light)}"/><path d="${path}" fill="${escapeXml(dark)}"/></svg>`;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character]));
}

export const qrCapacity = (version, level) => capacityBits(version, level);
export { ECC_LEVELS, RS_BLOCKS };
