import { describe, it, expect } from "vitest";
import { haversineMeters } from "./geo";

describe("haversineMeters", () => {
  it("is zero for identical points", () => {
    expect(haversineMeters(25.033, 121.5654, 25.033, 121.5654)).toBe(0);
  });

  it("approximates a 1 metre latitude offset", () => {
    const d = haversineMeters(25, 121, 25 + 1 / 111195, 121);
    expect(d).toBeGreaterThan(0.9);
    expect(d).toBeLessThan(1.1);
  });

  it("resolves the 20m geo-fence boundary", () => {
    const justInside = haversineMeters(25, 121, 25 + 19.9 / 111195, 121);
    const justOutside = haversineMeters(25, 121, 25 + 20.1 / 111195, 121);
    expect(justInside).toBeLessThan(20);
    expect(justOutside).toBeGreaterThan(20);
  });

  it("scales east-west distance by latitude", () => {
    const d = haversineMeters(25, 121, 25, 121.001);
    expect(d).toBeGreaterThan(95);
    expect(d).toBeLessThan(106);
  });
});
