import { describe, expect, it } from "vitest";
import { IA11y, IOsmA11y } from "../../types";
import { mergeA11yPlaces, osmToA11yPlace } from "./a11y.service";

function makeOsmDoc(overrides: Partial<IOsmA11y> = {}): IOsmA11y {
  return {
    osmId: "12342946149",
    name: "市府轉運站電梯",
    category: "elevator",
    wheelchair: "yes",
    tags: { highway: "elevator" },
    location: { type: "Point", coordinates: [121.5662, 25.0412] },
    importedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function makeMetroDoc(): Omit<IA11y, "_id"> {
  return {
    項次: "1",
    "出入口電梯/無障礙坡道名稱": "台北車站 M8 出口電梯",
    經度: 121.517,
    緯度: 25.0478,
    location: { type: "Point", coordinates: [121.517, 25.0478] },
  };
}

describe("osmToA11yPlace", () => {
  it("maps an OSM doc into the A11y response shape", () => {
    const place = osmToA11yPlace(makeOsmDoc());
    expect(place).toMatchObject({
      項次: "12342946149",
      "出入口電梯/無障礙坡道名稱": "市府轉運站電梯",
      經度: 121.5662,
      緯度: 25.0412,
      source: "osm",
      osmId: "12342946149",
      wheelchair: "yes",
      category: "elevator",
    });
  });

  it("falls back to a Chinese category name when the OSM node is unnamed", () => {
    const elevator = osmToA11yPlace(makeOsmDoc({ name: undefined }));
    expect(elevator["出入口電梯/無障礙坡道名稱"]).toBe("無障礙電梯");

    const ramp = osmToA11yPlace(
      makeOsmDoc({ name: undefined, category: "ramp" })
    );
    expect(ramp["出入口電梯/無障礙坡道名稱"]).toBe("無障礙坡道");
  });
});

describe("mergeA11yPlaces", () => {
  it("tags metro docs with source=metro and appends OSM elevators/ramps", () => {
    const merged = mergeA11yPlaces(
      [makeMetroDoc()],
      [makeOsmDoc(), makeOsmDoc({ osmId: "way/99", category: "ramp" })]
    );
    expect(merged).toHaveLength(3);
    expect(merged[0].source).toBe("metro");
    expect(merged[0]["出入口電梯/無障礙坡道名稱"]).toBe(
      "台北車站 M8 出口電梯"
    );
    expect(merged[1]).toMatchObject({ source: "osm", category: "elevator" });
    expect(merged[2]).toMatchObject({ source: "osm", category: "ramp" });
  });

  it("filters out non-structure OSM categories", () => {
    const merged = mergeA11yPlaces(
      [],
      [
        makeOsmDoc({ category: "toilet" }),
        makeOsmDoc({ category: "kerb_cut" }),
        makeOsmDoc({ category: "wheelchair_accessible" }),
        makeOsmDoc({ category: "elevator", osmId: "42" }),
      ]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].osmId).toBe("42");
  });
});
