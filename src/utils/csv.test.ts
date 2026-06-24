import { describe, it, expect } from "vitest";
import { parseCsvLine } from "./csv";

describe("parseCsvLine", () => {
  it("splits a plain row", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("keeps a comma inside a quoted field as one column", () => {
    const cols = parseCsvLine('機構,新北市,"計次收費,假日計時收費",身汽1');
    expect(cols).toHaveLength(4);
    expect(cols[2]).toBe("計次收費,假日計時收費");
  });

  it("unescapes doubled quotes inside a quoted field", () => {
    expect(parseCsvLine('"a ""b"" c",d')).toEqual(['a "b" c', "d"]);
  });

  it("preserves empty trailing field", () => {
    expect(parseCsvLine("a,b,")).toEqual(["a", "b", ""]);
  });
});
