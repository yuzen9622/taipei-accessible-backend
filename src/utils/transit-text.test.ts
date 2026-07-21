import { describe, it, expect } from "vitest";
import { formatWalkStepInstruction } from "./transit-text";

describe("formatWalkStepInstruction", () => {
  it("formats DEPART with street name", () => {
    expect(
      formatWalkStepInstruction({
        relativeDirection: "DEPART",
        streetName: "信義路",
        bogusName: false,
      }),
    ).toBe("請沿「信義路」出發");
  });

  it("formats DEPART without street name", () => {
    expect(
      formatWalkStepInstruction({
        relativeDirection: "DEPART",
        streetName: "",
        bogusName: true,
      }),
    ).toBe("請出發");
  });

  it("formats LEFT with street name", () => {
    expect(
      formatWalkStepInstruction({
        relativeDirection: "LEFT",
        streetName: "敦化南路",
        bogusName: false,
      }),
    ).toBe("在「敦化南路」，請向左轉");
  });

  it("formats RIGHT without street name", () => {
    expect(
      formatWalkStepInstruction({
        relativeDirection: "RIGHT",
        streetName: "",
        bogusName: true,
      }),
    ).toBe("請向右轉");
  });

  it("formats CONTINUE with street name", () => {
    expect(
      formatWalkStepInstruction({
        relativeDirection: "CONTINUE",
        streetName: "忠孝東路",
        bogusName: false,
      }),
    ).toBe("請繼續直行，沿「忠孝東路」前進");
  });

  it("formats ELEVATOR, ENTER_STATION, EXIT_STATION", () => {
    expect(formatWalkStepInstruction({ relativeDirection: "ELEVATOR" })).toBe(
      "請進入電梯",
    );
    expect(
      formatWalkStepInstruction({ relativeDirection: "ENTER_STATION" }),
    ).toBe("請進入車站");
    expect(
      formatWalkStepInstruction({ relativeDirection: "EXIT_STATION" }),
    ).toBe("請離開車站");
  });
});
