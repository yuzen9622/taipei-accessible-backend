import { describe, expect, it } from "vitest";
import { PLAN_QUERY, SUPPORTED_TRANSIT_MODES } from "./otp-routing";

// The OTP plan query must request an explicit mode allowlist (not the broad
// `TRANSIT` composite) so OTP never returns AIRPLANE/FERRY / offshore-island legs.
describe("OTP PLAN_QUERY transportModes allowlist", () => {
  const modes = [...SUPPORTED_TRANSIT_MODES];

  it("requests WALK plus every supported transit mode (single source of truth)", () => {
    expect(PLAN_QUERY).toContain("{ mode: WALK }");
    for (const m of modes) expect(PLAN_QUERY).toContain(`{ mode: ${m} }`);
  });

  it("does not request the broad TRANSIT composite or any air/water mode", () => {
    expect(PLAN_QUERY).not.toContain("{ mode: TRANSIT }");
    expect(PLAN_QUERY).not.toContain("AIRPLANE");
    expect(PLAN_QUERY).not.toContain("FERRY");
  });

  // Fixed-expectation guard: catches an accidental shrink of SUPPORTED_TRANSIT_MODES
  // that the dynamic test above would silently pass in lockstep with the query.
  it("resolves to exactly WALK + the 6 allowed transit modes", () => {
    const requested = [...PLAN_QUERY.matchAll(/\{ mode: (\w+) \}/g)].map((m) => m[1]);
    expect(new Set(requested)).toEqual(
      new Set(["WALK", "BUS", "TROLLEYBUS", "RAIL", "SUBWAY", "TRAM", "MONORAIL"]),
    );
  });
});
