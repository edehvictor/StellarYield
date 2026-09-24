import { describe, it, expect } from "vitest";
import {
  compareNumbers,
  compareStrings,
  directionFactor,
  stableSort,
} from "./stableSort";

interface Row {
  id: string;
  value: number;
  label: string;
}

function makeRow(id: string, value: number, label = id): Row {
  return { id, value, label };
}

const byValueDesc = (a: Row, b: Row) => b.value - a.value;
const byValueAsc = (a: Row, b: Row) => a.value - b.value;
const idOf = (row: Row) => row.id;

describe("stableSort — primary ordering", () => {
  it("sorts by the primary comparator ascending", () => {
    const rows = [makeRow("c", 3), makeRow("a", 1), makeRow("b", 2)];
    const sorted = stableSort(rows, byValueAsc, idOf);
    expect(sorted.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts by the primary comparator descending", () => {
    const rows = [makeRow("c", 3), makeRow("a", 1), makeRow("b", 2)];
    const sorted = stableSort(rows, byValueDesc, idOf);
    expect(sorted.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate the input array", () => {
    const rows = [makeRow("c", 3), makeRow("a", 1), makeRow("b", 2)];
    const original = [...rows];
    stableSort(rows, byValueDesc, idOf);
    expect(rows).toEqual(original);
  });

  it("returns a new array instance", () => {
    const rows = [makeRow("a", 1)];
    const sorted = stableSort(rows, byValueAsc, idOf);
    expect(sorted).not.toBe(rows);
  });
});

describe("stableSort — equal-value tie cases (#1118)", () => {
  it("orders equal-value rows by ascending id regardless of input order", () => {
    const a = makeRow("alpha", 5);
    const b = makeRow("mid", 5);
    const c = makeRow("zeta", 5);

    const permutations = [
      [a, b, c],
      [c, a, b],
      [b, c, a],
      [c, b, a],
    ];
    for (const input of permutations) {
      expect(stableSort(input, byValueDesc, idOf).map((r) => r.id)).toEqual([
        "alpha",
        "mid",
        "zeta",
      ]);
    }
  });

  it("keeps the final tiebreak ascending even when the primary sort is descending", () => {
    const rows = [makeRow("zeta", 5), makeRow("alpha", 5)];
    const sorted = stableSort(rows, byValueDesc, idOf);
    expect(sorted.map((r) => r.id)).toEqual(["alpha", "zeta"]);
  });

  it("produces identical output for every permutation of mixed values", () => {
    const rows = [
      makeRow("high-b", 10),
      makeRow("low-a", 1),
      makeRow("tie-b", 5),
      makeRow("high-a", 10),
      makeRow("tie-a", 5),
      makeRow("low-b", 1),
    ];
    const expected = stableSort(rows, byValueDesc, idOf).map((r) => r.id);
    expect(expected).toEqual([
      "high-a",
      "high-b",
      "tie-a",
      "tie-b",
      "low-a",
      "low-b",
    ]);

    // Deterministic across reshuffles (simulates backend response order changes).
    const shuffled = [...rows].reverse();
    expect(stableSort(shuffled, byValueDesc, idOf).map((r) => r.id)).toEqual(
      expected,
    );
    const shuffledAgain = [rows[2], rows[5], rows[0], rows[4], rows[3], rows[1]];
    expect(
      stableSort(shuffledAgain, byValueDesc, idOf).map((r) => r.id),
    ).toEqual(expected);
  });

  it("applies intermediate keys inside the comparator before the id fallback", () => {
    const rows = [
      makeRow("b-y", 5, "b"),
      makeRow("a-z", 5, "a"),
      makeRow("a-y", 5, "a"),
    ];
    const sorted = stableSort(
      rows,
      (a, b) => compareStrings(a.label, b.label) || a.value - b.value,
      idOf,
    );
    // label "a" rows first (tie on value → id fallback a-y < a-z), then "b".
    expect(sorted.map((r) => r.id)).toEqual(["a-y", "a-z", "b-y"]);
  });
});

describe("stableSort — helper functions", () => {
  it("directionFactor maps directions to ±1", () => {
    expect(directionFactor("asc")).toBe(1);
    expect(directionFactor("desc")).toBe(-1);
  });

  it("compareStrings orders alphabetically", () => {
    expect(compareStrings("Blend", "Alpha")).toBeGreaterThan(0);
    expect(compareStrings("Alpha", "Blend")).toBeLessThan(0);
    expect(compareStrings("Blend", "Blend")).toBe(0);
  });

  it("compareNumbers orders numerically and pushes NaN to the bottom", () => {
    expect(compareNumbers(1, 2)).toBeLessThan(0);
    expect(compareNumbers(2, 1)).toBeGreaterThan(0);
    expect(compareNumbers(2, 2)).toBe(0);
    expect(compareNumbers(Number.NaN, 1)).toBeGreaterThan(0);
    expect(compareNumbers(1, Number.NaN)).toBeLessThan(0);
    expect(compareNumbers(Number.NaN, Number.NaN)).toBe(0);
  });
});
