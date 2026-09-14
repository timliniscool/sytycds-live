/**
 * A deliberately small QR encoder for one job: putting the audience voting URL
 * on the projector. Browsers provide no QR generation, and the alternative was
 * a runtime dependency in the one surface that must never fail to render, so
 * the encoder lives here and is covered by tests.
 *
 * Scope is byte mode, versions 1-6 and error-correction levels Q/M/L. Version 6
 * holds 134 bytes at level L, far beyond any join URL, and staying below
 * version 7 means no version-information block is required.
 */

export type QrErrorCorrection = "L" | "M" | "Q";

export interface QrCode {
  size: number;
  version: number;
  errorCorrection: QrErrorCorrection;
  /** Row-major, `true` meaning a dark module. */
  modules: readonly (readonly boolean[])[];
}

interface BlockLayout {
  ecPerBlock: number;
  /** `[blockCount, dataCodewordsPerBlock]` groups, in interleaving order. */
  groups: readonly (readonly [number, number])[];
}

/** Table 13-22 of ISO/IEC 18004, restricted to the versions this app uses. */
const BLOCK_LAYOUT: Readonly<
  Record<number, Readonly<Record<QrErrorCorrection, BlockLayout>>>
> = {
  1: {
    L: { ecPerBlock: 7, groups: [[1, 19]] },
    M: { ecPerBlock: 10, groups: [[1, 16]] },
    Q: { ecPerBlock: 13, groups: [[1, 13]] },
  },
  2: {
    L: { ecPerBlock: 10, groups: [[1, 34]] },
    M: { ecPerBlock: 16, groups: [[1, 28]] },
    Q: { ecPerBlock: 22, groups: [[1, 22]] },
  },
  3: {
    L: { ecPerBlock: 15, groups: [[1, 55]] },
    M: { ecPerBlock: 26, groups: [[1, 44]] },
    Q: { ecPerBlock: 18, groups: [[2, 17]] },
  },
  4: {
    L: { ecPerBlock: 20, groups: [[1, 80]] },
    M: { ecPerBlock: 18, groups: [[2, 32]] },
    Q: { ecPerBlock: 26, groups: [[2, 24]] },
  },
  5: {
    L: { ecPerBlock: 26, groups: [[1, 108]] },
    M: { ecPerBlock: 24, groups: [[2, 43]] },
    Q: {
      ecPerBlock: 18,
      groups: [
        [2, 15],
        [2, 16],
      ],
    },
  },
  6: {
    L: { ecPerBlock: 18, groups: [[2, 68]] },
    M: { ecPerBlock: 16, groups: [[4, 27]] },
    Q: { ecPerBlock: 24, groups: [[4, 19]] },
  },
};

/** Alignment-pattern centre coordinates; version 1 has none. */
const ALIGNMENT_CENTRES: Readonly<Record<number, readonly number[]>> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
};

const FORMAT_BITS: Readonly<Record<QrErrorCorrection, number>> = {
  L: 1,
  M: 0,
  Q: 3,
};

const MAX_VERSION = 6;
/** Higher correction first: a hall projection is read at an angle and at range. */
const LEVELS: readonly QrErrorCorrection[] = ["Q", "M", "L"];

const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
for (let i = 0, value = 1; i < 256; i += 1) {
  EXP[i] = value;
  LOG[value] = i % 255;
  value = value << 1;
  if (value >= 256) value ^= 0x11d;
}

function multiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[((LOG[a] ?? 0) + (LOG[b] ?? 0)) % 255] ?? 0;
}

function generatorPolynomial(degree: number): number[] {
  let polynomial = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(polynomial.length + 1).fill(0);
    for (let j = 0; j < polynomial.length; j += 1) {
      const coefficient = polynomial[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ multiply(coefficient, EXP[i] ?? 0);
      next[j + 1] = (next[j + 1] ?? 0) ^ coefficient;
    }
    polynomial = next;
  }
  // Built lowest-degree-first; the division below wants the leading coefficient
  // at index 0, so the polynomial is reversed once here.
  return polynomial.reverse();
}

function errorCorrectionCodewords(data: readonly number[], count: number) {
  const generator = generatorPolynomial(count);
  const remainder = new Array<number>(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() ?? 0);
    remainder.push(0);
    for (let i = 0; i < remainder.length; i += 1) {
      remainder[i] =
        (remainder[i] ?? 0) ^ multiply(generator[i + 1] ?? 0, factor);
    }
  }
  return remainder;
}

function dataCapacity(layout: BlockLayout): number {
  return layout.groups.reduce(
    (total, [count, data]) => total + count * data,
    0,
  );
}

function selectVersion(byteLength: number): {
  version: number;
  errorCorrection: QrErrorCorrection;
} {
  // Smallest symbol first so the modules stay physically large on the wall,
  // then the strongest error correction that still fits inside it.
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    for (const level of LEVELS) {
      const layout = BLOCK_LAYOUT[version]?.[level];
      // Mode indicator and 8-bit character count occupy two codewords.
      if (layout && byteLength + 2 <= dataCapacity(layout)) {
        return { version, errorCorrection: level };
      }
    }
  }
  throw new Error("Text is too long for a version 6 QR symbol");
}

function encodeData(bytes: Uint8Array, layout: BlockLayout): number[] {
  const capacity = dataCapacity(layout);
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0);
    codewords.push(byte);
  }
  for (let pad = 0; codewords.length < capacity; pad += 1) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
  }
  return codewords;
}

function interleave(
  codewords: readonly number[],
  layout: BlockLayout,
): number[] {
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const [count, size] of layout.groups) {
    for (let block = 0; block < count; block += 1) {
      const data = codewords.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(data);
      ecBlocks.push(errorCorrectionCodewords(data, layout.ecPerBlock));
    }
  }

  const result: number[] = [];
  const longestData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longestData; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i] ?? 0);
    }
  }
  for (let i = 0; i < layout.ecPerBlock; i += 1) {
    for (const block of ecBlocks) result.push(block[i] ?? 0);
  }
  return result;
}

class Symbol2d {
  readonly version: number;
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.reserved = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
  }

  set(row: number, column: number, dark: boolean, reserve: boolean): void {
    const line = this.modules[row];
    const reservedLine = this.reserved[row];
    if (!line || !reservedLine) return;
    line[column] = dark;
    if (reserve) reservedLine[column] = true;
  }

  isReserved(row: number, column: number): boolean {
    return this.reserved[row]?.[column] ?? true;
  }

  isDark(row: number, column: number): boolean {
    return this.modules[row]?.[column] ?? false;
  }
}

function drawFinder(symbol: Symbol2d, row: number, column: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r;
      const x = column + c;
      if (y < 0 || y >= symbol.size || x < 0 || x >= symbol.size) continue;
      const distance = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      symbol.set(y, x, distance !== 2 && distance <= 3, true);
    }
  }
}

function drawFunctionPatterns(symbol: Symbol2d): void {
  drawFinder(symbol, 0, 0);
  drawFinder(symbol, 0, symbol.size - 7);
  drawFinder(symbol, symbol.size - 7, 0);

  for (let i = 8; i < symbol.size - 8; i += 1) {
    symbol.set(6, i, i % 2 === 0, true);
    symbol.set(i, 6, i % 2 === 0, true);
  }

  const centres = ALIGNMENT_CENTRES[symbol.version] ?? [];
  for (const row of centres) {
    for (const column of centres) {
      const nearFinder =
        (row === 6 && column === 6) ||
        (row === 6 && column === symbol.size - 7) ||
        (row === symbol.size - 7 && column === 6);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const distance = Math.max(Math.abs(r), Math.abs(c));
          symbol.set(row + r, column + c, distance !== 1, true);
        }
      }
    }
  }
}

function drawCodewords(symbol: Symbol2d, codewords: readonly number[]): void {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  // Column pairs walk right to left, skipping the vertical timing column.
  for (let right = symbol.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < symbol.size; vertical += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? symbol.size - 1 - vertical : vertical;
        if (symbol.isReserved(y, x) || bitIndex >= totalBits) continue;
        const byte = codewords[bitIndex >>> 3] ?? 0;
        symbol.set(y, x, ((byte >> (7 - (bitIndex & 7))) & 1) === 1, false);
        bitIndex += 1;
      }
    }
  }
}

function maskCondition(mask: number, row: number, column: number): boolean {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return column % 3 === 0;
    case 3:
      return (row + column) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default:
      return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

function applyMask(symbol: Symbol2d, mask: number): void {
  for (let row = 0; row < symbol.size; row += 1) {
    for (let column = 0; column < symbol.size; column += 1) {
      if (symbol.isReserved(row, column)) continue;
      if (maskCondition(mask, row, column)) {
        symbol.set(row, column, !symbol.isDark(row, column), false);
      }
    }
  }
}

function formatInformation(
  errorCorrection: QrErrorCorrection,
  mask: number,
): number {
  const data = (FORMAT_BITS[errorCorrection] << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >> 9) * 0x537);
  }
  return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412;
}

function drawFormatInformation(
  symbol: Symbol2d,
  errorCorrection: QrErrorCorrection,
  mask: number,
): void {
  const bits = formatInformation(errorCorrection, mask);
  const bit = (index: number) => ((bits >> index) & 1) === 1;

  for (let i = 0; i <= 5; i += 1) symbol.set(i, 8, bit(i), true);
  symbol.set(7, 8, bit(6), true);
  symbol.set(8, 8, bit(7), true);
  symbol.set(8, 7, bit(8), true);
  for (let i = 9; i < 15; i += 1) symbol.set(8, 14 - i, bit(i), true);

  for (let i = 0; i < 8; i += 1) {
    symbol.set(8, symbol.size - 1 - i, bit(i), true);
  }
  for (let i = 8; i < 15; i += 1) {
    symbol.set(symbol.size - 15 + i, 8, bit(i), true);
  }
  symbol.set(symbol.size - 8, 8, true, true);
}

function runPenalty(run: number): number {
  return run >= 5 ? 3 + (run - 5) : 0;
}

function linePenalty(line: readonly boolean[]): number {
  let penalty = 0;
  let run = 1;
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === line[i - 1]) {
      run += 1;
    } else {
      penalty += runPenalty(run);
      run = 1;
    }
  }
  penalty += runPenalty(run);

  // Rule 3: a finder-like 1:1:3:1:1 sequence bordered by four light modules.
  const pattern = [true, false, true, true, true, false, true];
  const light = [false, false, false, false];
  const matches = (start: number, expected: readonly boolean[]) =>
    expected.every((value, index) => line[start + index] === value);
  for (let i = 0; i + 7 <= line.length; i += 1) {
    if (!matches(i, pattern)) continue;
    const before = i >= 4 && matches(i - 4, light);
    const after = i + 11 <= line.length && matches(i + 7, light);
    if (before || after) penalty += 40;
  }
  return penalty;
}

function penaltyScore(symbol: Symbol2d): number {
  let penalty = 0;
  let dark = 0;

  for (let row = 0; row < symbol.size; row += 1) {
    const horizontal: boolean[] = [];
    const vertical: boolean[] = [];
    for (let column = 0; column < symbol.size; column += 1) {
      horizontal.push(symbol.isDark(row, column));
      vertical.push(symbol.isDark(column, row));
      if (symbol.isDark(row, column)) dark += 1;
    }
    penalty += linePenalty(horizontal) + linePenalty(vertical);
  }

  for (let row = 0; row + 1 < symbol.size; row += 1) {
    for (let column = 0; column + 1 < symbol.size; column += 1) {
      const first = symbol.isDark(row, column);
      if (
        first === symbol.isDark(row, column + 1) &&
        first === symbol.isDark(row + 1, column) &&
        first === symbol.isDark(row + 1, column + 1)
      ) {
        penalty += 3;
      }
    }
  }

  const total = symbol.size * symbol.size;
  const deviation = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return penalty + Math.max(0, deviation) * 10;
}

/** Encodes UTF-8 text as the smallest byte-mode symbol that fits. */
export function encodeQr(text: string): QrCode {
  const bytes = new TextEncoder().encode(text);
  const { version, errorCorrection } = selectVersion(bytes.length);
  const layout = BLOCK_LAYOUT[version]?.[errorCorrection];
  if (!layout) throw new Error("Unsupported QR configuration");
  const codewords = interleave(encodeData(bytes, layout), layout);

  let best: Symbol2d | null = null;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const symbol = new Symbol2d(version);
    drawFunctionPatterns(symbol);
    // Reserving the format modules before placement keeps them out of the
    // zigzag; the real bits are written once the mask is known.
    drawFormatInformation(symbol, errorCorrection, 0);
    drawCodewords(symbol, codewords);
    applyMask(symbol, mask);
    drawFormatInformation(symbol, errorCorrection, mask);
    const penalty = penaltyScore(symbol);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = symbol;
    }
  }
  if (!best) throw new Error("QR masking produced no symbol");

  return {
    size: best.size,
    version,
    errorCorrection,
    modules: best.modules,
  };
}

/**
 * Renders the symbol as one SVG path so the projector draws a single element
 * rather than a thousand rectangles.
 */
export function qrPath(code: QrCode): string {
  const segments: string[] = [];
  for (let row = 0; row < code.size; row += 1) {
    const line = code.modules[row];
    if (!line) continue;
    for (let column = 0; column < code.size; column += 1) {
      if (line[column]) segments.push(`M${column} ${row}h1v1h-1z`);
    }
  }
  return segments.join("");
}
