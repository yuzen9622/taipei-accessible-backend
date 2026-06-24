import { describe, it, expect } from "vitest";
import { parseCsvLine } from "../utils/csv";
import { rowToWelfare } from "./welfare-parse";

const SAMPLE =
  "新北市政府社會局委託天主教耕莘醫療財團法人永和耕莘醫院辦理新北市愛維養護中心,新北市,八里區,新北市八里區華富山35號,02-86304104,全日型住宿式機構,173,0,0,154,0,0,11,優";

describe("rowToWelfare", () => {
  it("maps the 14 columns by position", () => {
    const doc = rowToWelfare(parseCsvLine(SAMPLE));
    expect(doc).not.toBeNull();
    expect(doc!.county).toBe("新北市");
    expect(doc!.district).toBe("八里區");
    expect(doc!.address).toBe("新北市八里區華富山35號");
    expect(doc!.phone).toBe("02-86304104");
    expect(doc!.type).toBe("全日型住宿式機構");
    expect(doc!.evaluationGrade).toBe("優");
  });

  it("parses capacity numbers", () => {
    const doc = rowToWelfare(parseCsvLine(SAMPLE))!;
    expect(doc.approvedCapacity.residential).toBe(173);
    expect(doc.actualServed.residential).toBe(154);
    expect(doc.approvedCapacity.day).toBe(0);
  });

  it("returns null for a row with too few columns", () => {
    expect(rowToWelfare(["機構", "新北市"])).toBeNull();
  });

  it("returns null when required fields are blank", () => {
    const blank = parseCsvLine(",,,,,,,,,,,,,");
    expect(rowToWelfare(blank)).toBeNull();
  });
});
