import { describe, expect, it } from "vitest";

import { encodeQr, qrPath } from "../src/projector/qr";

/**
 * Verified against an independent QR implementation and decoded with jsQR:
 * this symbol is byte-identical to the reference encoder's output.
 */
const HELLO_V1Q = [
  "#######..##...#######",
  "#.....#....#..#.....#",
  "#.###.#.##.##.#.###.#",
  "#.###.#..###..#.###.#",
  "#.###.#.#.....#.###.#",
  "#.....#.#.#.#.#.....#",
  "#######.#.#.#.#######",
  ".........##.#........",
  ".#..#.#.###..#.##.#..",
  "#.#....#.#.....#.####",
  "...#.##..###..###..#.",
  "###.#..##.#####.#....",
  "#...####.##..##...##.",
  "........####.##..#.##",
  "#######..###.#...#.#.",
  "#.....#...#....#...#.",
  "#.###.#.#####.###.#.#",
  "#.###.#...###....#.##",
  "#.###.#...##..####...",
  "#.....#.##...##......",
  "#######.....#####.#.#",
];

function render(text: string): string[] {
  const code = encodeQr(text);
  return code.modules.map((row) =>
    row.map((module) => (module ? "#" : ".")).join(""),
  );
}

describe("projector QR encoder", () => {
  it("produces the reference symbol for a known input", () => {
    const code = encodeQr("HELLO");
    expect(code.version).toBe(1);
    expect(code.errorCorrection).toBe("Q");
    expect(code.size).toBe(21);
    expect(render("HELLO")).toEqual(HELLO_V1Q);
  });

  it("chooses the smallest symbol and strongest correction that fits", () => {
    expect(encodeQr("http://localhost:5173/vote")).toMatchObject({
      version: 2,
      errorCorrection: "M",
      size: 25,
    });
    expect(encodeQr("https://sytycds.example.school.nz/vote")).toMatchObject({
      version: 3,
      errorCorrection: "M",
    });
    // 70 bytes no longer fits version 3, and only level L fits in version 4.
    expect(
      encodeQr(
        "https://a-much-longer-school-domain-name.example.org/vote?show=primary",
      ),
    ).toMatchObject({ version: 4, errorCorrection: "L" });
  });

  it("places the three finder patterns and both timing lines", () => {
    const code = encodeQr("https://example.test/vote");
    const dark = (row: number, column: number) =>
      code.modules[row]?.[column] === true;
    for (const [row, column] of [
      [0, 0],
      [0, code.size - 7],
      [code.size - 7, 0],
    ] as const) {
      for (let i = 0; i < 7; i += 1) {
        expect(dark(row, column + i)).toBe(true);
        expect(dark(row + 6, column + i)).toBe(true);
      }
      expect(dark(row + 1, column + 1)).toBe(false);
      expect(dark(row + 3, column + 3)).toBe(true);
    }
    for (let i = 8; i < code.size - 8; i += 1) {
      expect(dark(6, i)).toBe(i % 2 === 0);
      expect(dark(i, 6)).toBe(i % 2 === 0);
    }
    // The dark module is fixed by the specification.
    expect(dark(code.size - 8, 8)).toBe(true);
  });

  it("refuses text beyond the supported symbol range", () => {
    expect(() => encodeQr("x".repeat(200))).toThrow(/too long/u);
  });

  it("renders one path covering exactly the dark modules", () => {
    const code = encodeQr("HELLO");
    const darkCount = code.modules.flat().filter(Boolean).length;
    expect(qrPath(code).match(/M/gu)?.length).toBe(darkCount);
  });
});
