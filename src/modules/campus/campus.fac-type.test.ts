import { describe, it, expect } from "vitest";
import {
  CAMPUS_FAC_TYPES,
  CAMPUS_FAC_TYPE_CODES,
  codeToId,
  resolveFacType,
} from "./campus.fac-type";

describe("campus fac-type registry", () => {
  it("lists all 13 MOE facility types", () => {
    expect(CAMPUS_FAC_TYPES.length).toBe(13);
    expect(CAMPUS_FAC_TYPE_CODES).toContain("elevator");
    expect(CAMPUS_FAC_TYPE_CODES).toContain("accessible_toilet");
  });

  it("maps code → MOE facTypeId", () => {
    expect(codeToId("elevator")).toBe(8);
    expect(codeToId("ramp")).toBe(2);
    expect(codeToId("accessible_toilet")).toBe(6);
    expect(codeToId("nope")).toBeUndefined();
  });

  it("resolves by id first, then Chinese-label fallback", () => {
    expect(resolveFacType(8)?.code).toBe("elevator");
    expect(resolveFacType(undefined, "無障礙電梯")?.code).toBe("elevator");
    expect(resolveFacType(999, "未知類型")).toBeUndefined();
  });
});
